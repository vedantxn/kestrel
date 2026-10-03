"""W8: browser-use on a Kestrel session. Prints RESULT: <final answer>. Run by bench/framework/src/agents.ts."""
import asyncio
import os

from browser_use import Agent, Browser, ChatAnthropic


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
