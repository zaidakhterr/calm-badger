# Product text style

RFQ Relay uses an ASD-STE100-inspired form of Simplified Technical English for
all public product text and technical explanations.

This is a house style. It is not a claim of formal ASD-STE100 conformance.

## Rules

- Use one instruction or fact in each sentence.
- Keep a sentence at 20 words or fewer when possible.
- Use active voice.
- Use the present tense for current system behavior.
- Use the imperative form for instructions.
- Use the same term for the same thing. Use the terms in `CONTEXT.md`.
- Use short, common words. Keep a technical term only when it is necessary.
- Define an abbreviation at its first use on a page.
- Do not use idioms, marketing language, or rhetorical questions.
- Do not use a slash to mean "and" or "or" in prose.
- Put conditions before the instruction when this prevents ambiguity.
- Put warnings before the action that can cause harm.
- Use lists for three or more related facts.
- Give the result of an action in the button label. For example, use
  **Approve and continue**, not **Submit**.

## Interface density

- Show the decision and the required action first.
- Put diagnostic evidence in a disclosure named **Why this needs review** or
  **Technical details**.
- Do not repeat a fact in the step summary, panel notice, and action area.
- Keep secondary policy text out of the main task flow when a short label or a
  tooltip is sufficient.
- Show raw provider data only in an optional disclosure.

## Preferred terms

| Use              | Do not use                             |
| ---------------- | -------------------------------------- |
| request          | submission, input, inbound demand      |
| run              | execution, job                         |
| line             | position, line item, item              |
| product match    | catalogue decision, selection decision |
| review           | human-in-the-loop checkpoint           |
| proposed product | winner, leading candidate              |
| start again      | start over, rerun                      |
| stored           | persisted                              |
| use              | leverage, utilize                      |
| stops            | terminates, ends in a terminal state   |

## Review pattern

Each review card shows this information in this order:

1. Type and line number.
2. Source text.
3. Proposed value.
4. Primary action.
5. Alternatives or search.
6. Optional diagnostic evidence.
