import json
with open('/home/hom/.claude/projects/-home-hom-code-task-tracker-sim-work-user06/3b683ff4-6ac6-4619-8f71-5554b0c976ad/tool-results/bfwxztqm8.txt') as f:
    data = json.load(f)
mine = [t for t in data if t.get('assignee_id')=='dcbef905-d80a-4b63-9099-9a90402327e5' and t.get('status') in ('Todo','Doing')]
for t in mine:
    print(t['status'], '|', t['task_id'], '|', t['title'], '|', t['updated_at'])
