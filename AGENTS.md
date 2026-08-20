# DomainScout dogfood contract

- Treat Hamp's requests to dogfood end to end as durable product work: reproduce the real user flow, fix encountered product defects in scope, deploy through the owned release lane, and verify the result. Do not stop at source-complete work.
- “All extensions”, “whole universe”, and equivalent language mean every extension currently accessible to the configured zone-data account. Report the accessible-zone denominator, successes, failures, snapshot dates, and whether the result is complete. A partial or stale subset must be labeled as a preview or lower bound, never 100% complete.
- Preserve observed extension evidence when exact whole-universe verification is unavailable. Display it as an explicit lower bound; never replace a known count with an empty cell merely because a stronger receipt is pending.
- Keep extension breadth and trend velocity distinct. Breadth is how many extensions currently contain a string. A trend requires dated evidence that the string was newly observed across multiple extensions in a daily zone diff, with the source and exact TLD set visible when retained.
- Track both exact-string velocity and dictionary-backed words within distinct newly registered names. Word trends must preserve click-through evidence for the actual names and TLDs that caused the signal; never present an opaque token score.
- Search result ordering must be deterministic and re-applied when extension evidence changes. Default extension ranking is descending, with unknown values last.
- Any shared research primitive must remain provider- and keyword-neutral. Tests must include an unrelated prefix fixture so motivating strings such as `agent` are not hard-coded.
