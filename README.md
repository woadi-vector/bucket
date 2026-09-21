# Bucket

Build a polished frontend-only prototype for a personal budgeting app called

"Bucket" (placeholder name — easy to rename). This is a clickable demo: NO

backend, NO auth, NO real bank APIs. All data lives in in-memory React state,

hardcoded to start. Optimize for a beautiful, satisfying demo, not real

infrastructure.

THE CORE IDEA:

Most budgeting apps track spending after it happens. Bucket moves the decision

to the FRONT — before any purchase clears, the user must consciously assign it

to a spending "bucket" and tag it as a WANT or a NEED. That deliberate pause is

the entire product. Make that moment feel great.

THREE SCREENS:

1. BUCKET DASHBOARD (home)

- Show 4 hardcoded buckets as cards: Groceries ($420), Dining Out ($85),

  Kids' Allowance ($50), Savings ($1,200). Each card shows name, current

  balance, and a subtle progress/spent indicator.

- A clear total-balance header at top.

- A primary button: "New Purchase" — this launches the interception flow.

- Let users create a new bucket (name + starting amount) via a simple modal.

2. PURCHASE INTERCEPTION (the star — make this shine)

- Triggered by "New Purchase." User enters an amount and a merchant/label.

- Then a deliberate, full-attention step: "Is this a WANT or a NEED?"

  Two large, tactile toggle buttons. This choice is required to proceed.

- Then: "Which bucket?" — pick from the bucket cards.

- Then a confirmation moment with a satisfying micro-interaction (gentle

  animation, haptic-style pulse, checkmark) and the chosen bucket's balance

  visibly ticks down in real time afterward.

- The whole flow should feel like a calm checkpoint that makes you DECIDE —

  not a nag, not a warning. A half-second of intentionality.

3. PARENTAL VIEW (toggle in header)

- A switch flips the dashboard into "Parent" mode.

- In parent mode, the user can set a spending limit on the Kids' Allowance

  bucket. If a purchase would exceed it, the interception flow shows a soft

  guardrail message instead of approving.

DATA MODEL (keep it modular):

- Bucket: { id, name, balance, limit (nullable), ownerType: "self" | "child" }

- Transaction: { id, amount, label, bucketId, intent: "want" | "need",

  timestamp, readinessTag }

- Include readinessTag on every transaction as a hidden field (default null /

  dummy value). Do NOT surface it anywhere in the UI — it's reserved for future

  use. Just keep it in the schema.

AESTHETIC:

- Clean, modern, trustworthy, premium. This is shared/family money, so warm and

  calm — not cold or tactical. Soft neutral background, one confident accent

  color, generous whitespace, rounded cards, crisp typography.

- Where it should feel high-end is in PRECISION: tight spacing, smooth

  transitions, responsive tactile feedback on every tap. The polish lives in

  the interactions, not in heavy chrome.

- Fully responsive; looks great on mobile.

Prioritize one flawless happy-path loop: view buckets → New Purchase → want/need

→ pick bucket → satisfying confirm → balance updates. Get that perfect first.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://intentional-spending-hub.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/851c851a-af9f-4766-950b-a887f7851849).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
