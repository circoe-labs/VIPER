"""AI drafting of Contact messages (Contact port Slice S5; handoff Task 14, decisions 22 and 26).

`prompt` builds the versioned prompt from the data VIPER holds (pure); `openai_client` is the
OpenAI adapter (Responses API, strict structured output, bounded retries, typed errors). The
orchestration and the persistence as a draft: `app.services.contact_mail_generation`.
"""
