const fs = require('fs');
const content = fs.readFileSync('comment_body_b399.txt', 'utf8');
fs.writeFileSync('comment_payload_b399.json', JSON.stringify({ content }));
