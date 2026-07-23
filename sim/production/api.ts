// 正式環境 sim 協調器的 task-tracker HTTP API client。
//
// 這個檔案只負責 I/O：短生命週期 http.request（agent: false、明確 timeout）、
// cookie jar、JSON／status 驗證，以及安全操作（health／login／GET）的暫時性
// 失敗重試。**不含任何決策邏輯**——要不要指派誰、要不要重新排程，都是
// policy.ts 的責任。
import { request as httpRequest } from 'node:http';
import { URL } from 'node:url';
import type { CommentSnapshot, NotificationSnapshot, TaskSnapshot, TaskStatus } from './policy';

export type { CommentSnapshot, NotificationSnapshot, TaskSnapshot };

// ---------------------------------------------------------------------------
// Mutation 結果不確定時的專用 error type：postCommentOnce／patchTaskField
// 在收到不確定的結果（連線層失敗、或 5xx 但沒有可信 body）時一律拋出這個，
// 絕不自動重送同一個 mutating request。呼叫端必須先用安全的 GET
// （getTask／listComments）readback，自行判斷這個 actionKey 代表的 mutation
// 是否已經生效，再決定要不要重試。
// ---------------------------------------------------------------------------
export class UncertainMutationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UncertainMutationError';
  }
}

interface RawResponse {
  status: number;
  body: string;
}

export interface TaskTrackerClientOptions {
  baseUrl: string;
  /** 單一 request 的 socket idle timeout；預設 5000ms。 */
  timeoutMs?: number;
  /** 安全操作（health／login／GET）額外重試次數；預設 2（總共最多嘗試 3 次）。 */
  retries?: number;
  retryDelayMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 20;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 判斷是否為「暫時性」connection-level 失敗（socket／timeout），值得重試。 */
function isRetryableNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'EPIPE' || code === 'EHOSTUNREACH') {
    return true;
  }
  return err.message === 'socket hang up' || err.message === 'request timeout';
}

// ---------------------------------------------------------------------------
// Wire 格式（snake_case，來自 task-tracker 的 JSON API）-> policy 用的 camelCase
// ---------------------------------------------------------------------------
interface WireTaskRow {
  task_id: string;
  workspace_id: string;
  title: string;
  status: TaskStatus;
  assignee_id: string | null;
  due_at: string | null;
  version: number;
  updated_at: string | null;
}

function mapTask(row: WireTaskRow): TaskSnapshot {
  return {
    taskId: row.task_id,
    workspaceId: row.workspace_id,
    title: row.title,
    status: row.status,
    assigneeId: row.assignee_id,
    dueAt: row.due_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

interface WireCommentRow {
  comment_id: string;
  task_id: string;
  user_id: string;
  content: string;
  created_at: string;
}

function mapComment(row: WireCommentRow): CommentSnapshot {
  return {
    commentId: row.comment_id,
    taskId: row.task_id,
    userId: row.user_id,
    content: row.content,
    createdAt: row.created_at,
  };
}

interface WireNotificationRow {
  notification_id: string;
  recipient_id: string;
  source_task_id: string;
  source_comment_id: string;
  snippet: string;
  created_at: string;
  read_at: string | null;
}

function mapNotification(row: WireNotificationRow): NotificationSnapshot {
  return {
    notificationId: row.notification_id,
    recipientId: row.recipient_id,
    sourceTaskId: row.source_task_id,
    sourceCommentId: row.source_comment_id,
    snippet: row.snippet,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

export class TaskTrackerClient {
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly cookies = new Map<string, string>();

  constructor(options: TaskTrackerClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  private cookieHeader(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  private captureCookies(setCookie: string | string[] | undefined): void {
    if (!setCookie) return;
    const entries = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const raw of entries) {
      const pair = raw.split(';', 1)[0];
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (name) this.cookies.set(name, value);
    }
  }

  /** 短生命週期單次 HTTP request：agent: false、明確 timeout，不含任何重試邏輯。 */
  private rawRequest(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settleResolve = (value: RawResponse) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      const settleReject = (err: unknown) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

      const payload = body === undefined ? undefined : JSON.stringify(body);
      const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extraHeaders };
      if (payload !== undefined) headers['Content-Length'] = String(Buffer.byteLength(payload));
      const cookie = this.cookieHeader();
      if (cookie) headers.Cookie = cookie;

      const req = httpRequest(
        {
          method,
          hostname: this.baseUrl.hostname,
          port: this.baseUrl.port,
          path,
          agent: false, // 短生命週期：不重用連線，避免 keep-alive 造成的 socket 狀態污染
          timeout: this.timeoutMs,
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            this.captureCookies(res.headers['set-cookie']);
            settleResolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
          });
          res.on('error', (err) => settleReject(err));
        },
      );
      req.on('timeout', () => {
        req.destroy(new Error('request timeout'));
      });
      req.on('error', (err) => settleReject(err));
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  /**
   * 安全操作（health／login／GET）的重試包裝：暫時性 socket／timeout／5xx
   * 失敗時重試，最多 `retries` 次額外嘗試。非暫時性錯誤（例如程式錯誤）不消耗
   * 重試預算，直接拋出並保留 `error.cause`。
   */
  private async safeRequest(method: string, path: string, body?: unknown): Promise<RawResponse> {
    let lastNetworkError: unknown;
    let lastFailedResponse: RawResponse | undefined;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      let res: RawResponse;
      try {
        res = await this.rawRequest(method, path, body);
      } catch (err) {
        if (attempt < this.retries && isRetryableNetworkError(err)) {
          lastNetworkError = err;
          await delay(this.retryDelayMs);
          continue;
        }
        throw new Error(`${method} ${path} failed after ${attempt + 1} attempt(s)`, { cause: err });
      }

      // 5xx 的重試判斷刻意放在 try/catch 之外：耗盡重試預算後拋出的 Error 才不會
      // 被上面那個只負責 network-level 失敗的 catch 攔截、包成一層多餘的巢狀 Error。
      if (res.status >= 500) {
        lastFailedResponse = res;
        if (attempt < this.retries) {
          await delay(this.retryDelayMs);
          continue;
        }
        // 重試預算耗盡、仍是 5xx：必須拋出並把造成失敗的 response 放進 cause，
        // 不能把失敗的 raw response 直接 return 給呼叫端當成功處理
        // （那樣 error.cause 就悄悄消失了——這正是這裡要修的 bug）。
        throw new Error(`${method} ${path} failed after ${attempt + 1} attempt(s): HTTP ${res.status}`, {
          cause: { status: res.status, body: res.body },
        });
      }

      return res;
    }
    // 迴圈一定會在上面 return 或 throw；這裡只是滿足型別檢查的 fallback。
    throw new Error(`${method} ${path} failed after retries`, {
      cause: lastFailedResponse ? { status: lastFailedResponse.status, body: lastFailedResponse.body } : lastNetworkError,
    });
  }

  async health(): Promise<{ status: string; db: boolean; rev: string }> {
    const res = await this.safeRequest('GET', '/api/health');
    if (res.status !== 200) throw new Error(`health failed: HTTP ${res.status} ${res.body}`);
    return JSON.parse(res.body) as { status: string; db: boolean; rev: string };
  }

  async login(email: string, password: string): Promise<void> {
    const res = await this.safeRequest('POST', '/api/auth/login', { email, password });
    if (res.status !== 200) throw new Error(`login failed: HTTP ${res.status} ${res.body}`);
  }

  async getTask(taskId: string): Promise<TaskSnapshot> {
    const res = await this.safeRequest('GET', `/api/tasks/${encodeURIComponent(taskId)}`);
    if (res.status !== 200) throw new Error(`getTask failed: HTTP ${res.status} ${res.body}`);
    return mapTask(JSON.parse(res.body) as WireTaskRow);
  }

  async listWorkspaceTasks(workspaceId: string): Promise<TaskSnapshot[]> {
    const res = await this.safeRequest('GET', `/api/workspaces/${encodeURIComponent(workspaceId)}/tasks`);
    if (res.status !== 200) throw new Error(`listWorkspaceTasks failed: HTTP ${res.status} ${res.body}`);
    return (JSON.parse(res.body) as WireTaskRow[]).map(mapTask);
  }

  async listComments(taskId: string): Promise<CommentSnapshot[]> {
    const res = await this.safeRequest('GET', `/api/tasks/${encodeURIComponent(taskId)}/comments`);
    if (res.status !== 200) throw new Error(`listComments failed: HTTP ${res.status} ${res.body}`);
    return (JSON.parse(res.body) as WireCommentRow[]).map(mapComment);
  }

  /**
   * 送出一次留言。`actionKey` 是呼叫端算好的穩定字串（帶到 `X-Action-Key`
   * header，供未來 server 端冪等比對；本層不解讀留言內容）。
   *
   * 若結果不確定（連線層失敗，或 5xx 但沒有可信 body），**不會**自動重送這個
   * POST——會拋出 UncertainMutationError，呼叫端必須自己 listComments()
   * readback，比對是否已有符合這個 actionKey 語意的留言存在，再決定要不要
   * 重送。
   */
  async postCommentOnce(taskId: string, content: string, actionKey: string): Promise<string> {
    let res: RawResponse;
    try {
      res = await this.rawRequest('POST', `/api/tasks/${encodeURIComponent(taskId)}/comments`, { content }, {
        'X-Action-Key': actionKey,
      });
    } catch (err) {
      throw new UncertainMutationError(
        `postCommentOnce uncertain (actionKey=${actionKey}): request failed before a response was received`,
        { cause: err },
      );
    }
    if (res.status === 200 || res.status === 201) {
      return (JSON.parse(res.body) as { id: string }).id;
    }
    if (res.status >= 500) {
      throw new UncertainMutationError(`postCommentOnce uncertain (actionKey=${actionKey}): HTTP ${res.status}`, {
        cause: new Error(res.body),
      });
    }
    throw new Error(`postCommentOnce failed: HTTP ${res.status} ${res.body}`);
  }

  /**
   * PATCH 單一欄位。同樣：結果不確定時拋出 UncertainMutationError 而不是盲目
   * 重送 PATCH；呼叫端必須自己用 getTask() readback 目前狀態再決定下一步。
   * 只有在收到明確成功（HTTP 200）之後，才用一次安全、可重試的 GET 讀回最新
   * TaskSnapshot 當作回傳值——這不是「重送 mutation」，只是讀回結果。
   */
  async patchTaskField(taskId: string, field: 'status' | 'assignee', value: unknown): Promise<TaskSnapshot> {
    let res: RawResponse;
    try {
      res = await this.rawRequest('PATCH', `/api/tasks/${encodeURIComponent(taskId)}`, { [field]: value });
    } catch (err) {
      throw new UncertainMutationError(
        `patchTaskField uncertain (task=${taskId}, field=${field}): request failed before a response was received`,
        { cause: err },
      );
    }
    if (res.status >= 500) {
      throw new UncertainMutationError(`patchTaskField uncertain (task=${taskId}, field=${field}): HTTP ${res.status}`, {
        cause: new Error(res.body),
      });
    }
    if (res.status !== 200) {
      throw new Error(`patchTaskField failed: HTTP ${res.status} ${res.body}`);
    }
    return this.getTask(taskId);
  }

  async listNotifications(): Promise<NotificationSnapshot[]> {
    const res = await this.safeRequest('GET', '/api/notifications');
    if (res.status !== 200) throw new Error(`listNotifications failed: HTTP ${res.status} ${res.body}`);
    return (JSON.parse(res.body) as WireNotificationRow[]).map(mapNotification);
  }
}
