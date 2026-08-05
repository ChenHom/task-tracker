import json

with open('comment_body_b399.txt', 'r', encoding='utf-8') as f:
    content = f.read()

with open('comment_payload_b399.json', 'w', encoding='utf-8') as f:
    json.dump({"content": content}, f, ensure_ascii=False)
