import json
with open('/home/hom/.claude/projects/-home-hom-code-task-tracker-sim-work-user02/f91d30ee-43ce-4dd5-82b4-2c0480b8a54e/tool-results/b4j4tf7eu.txt') as f:
    data = json.load(f)
mine = [t for t in data if t.get('assignee_id') == 'bb628344-aa02-47a4-b88e-944146d2c03d' and t.get('status') in ('Todo','Doing')]
for t in mine:
    print(t['task_id'], '|', t['status'], '|', t['priority'], '|', t['title'], '|', t['updated_at'])
