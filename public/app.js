fetch('/api/health')
  .then((res) => res.json())
  .then((data) => {
    document.getElementById('status').textContent =
      `API status: ${data.status}, DB: ${data.db ? 'connected' : 'error'}`;
  })
  .catch(() => {
    document.getElementById('status').textContent = 'API unreachable';
  });
