# kestrel-browser

Python client for [Kestrel](https://github.com/vedantxn/kestrel), open-source, self-hostable cloud browsers for AI agents.

```
pip install 'kestrel-browser[playwright]'
```

```python
from kestrel_browser import Kestrel

kestrel = Kestrel()  # reads KESTREL_URL and KESTREL_API_KEY
with kestrel.connect() as kb:  # a fresh, isolated Chrome with Playwright attached
    page = kb.browser.contexts[0].pages[0]
    page.goto("https://example.com")
    print(page.title())
# leaving the block closes the browser and stops the session
```

Without Playwright, `kestrel.sessions.create()` returns a session whose `connect_url` any Chrome DevTools Protocol client can use. `AsyncKestrel` is the asyncio version. The full API is in the [agent docs](https://github.com/vedantxn/kestrel/tree/main/docs/agents).
