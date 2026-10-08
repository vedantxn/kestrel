# @kestrel/cli

Command line for [Kestrel](https://github.com/vedantxn/kestrel), open-source, self-hostable cloud browsers for AI agents.

```
npm i -g @kestrel/cli
export KESTREL_URL=https://your-kestrel-host KESTREL_API_KEY=ksl_...
kestrel sessions create       # prints the session and its connectUrl
kestrel sessions list
kestrel logs <session id> --follow  # its events until it ends
kestrel --help
```
