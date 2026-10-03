"""W8: browser-use on a Kestrel session. Prints RESULT: <final answer>. Run by bench/framework/src/agents.ts."""
import asyncio
import os

import anthropic.resources.messages as _messages
from browser_use import Agent, Browser, ChatAnthropic

# Shim for a browser-use / Claude 5 incompatibility, unrelated to Kestrel: browser-use forces
# `tool_choice` to its one output tool, which Claude 5 models refuse ("tool_choice: type tool and
# any are not supported"). With only that one tool offered, `auto` gets the same call.
_create = _messages.AsyncMessages.create


async def _create_auto(self, *args, **kwargs):
    if isinstance(kwargs.get("tool_choice"), dict) and kwargs["tool_choice"].get("type") in ("tool", "any"):
        kwargs["tool_choice"] = {"type": "auto"}
    return await _create(self, *args, **kwargs)


_messages.AsyncMessages.create = _create_auto


async def main() -> None:
    browser = Browser(cdp_url=os.environ["CDP_URL"])
    agent = Agent(
        task=f"Open {os.environ['TEST_PAGE_URL']} and reply with the exact text of the page's main heading or title, nothing else.",
        llm=ChatAnthropic(model=os.environ.get("AGENT_MODEL", "claude-sonnet-5-5")),
        browser=browser,
    )
    result = await agent.run(max_steps=8)
    print("RESULT:", (result.final_result() or "").replace("\n", " "))


asyncio.run(main())
