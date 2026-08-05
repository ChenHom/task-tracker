import json
with open('/home/hom/.claude/projects/-home-hom-code-task-tracker-sim-work-user02/09e76021-a604-4059-9332-ae54010a5490/tool-results/b9tr3zy81.txt') as f:
    data = json.load(f)
mine = [t for t in data if t.get('assignee_id') == 'bb628344-aa02-47a4-b88e-944146d2c03d' and t.get('status') in ('Todo','Doing')]
for t in mine:
    print(t['status'], '|', t['task_id'], '|', t['title'], '|', t['updated_at'])
