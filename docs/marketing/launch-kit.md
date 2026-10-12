# Dimts launch kit: website + waitlist

For: the founder, posting from their own accounts. Every link carries `?ref=<channel>`; the waitlist stores it in `source` (for example `home-hero:reddit-realtors`), so `node --env-file=../.env server/scripts/waitlist.js` shows which channel worked.

Site: https://dimts-site.vercel.app (move to dimts.app once registered: replace the URL in site/ and here, add the domain to the dimts-site Vercel project)

## Order of work (organic first, $20 ads only as a funnel smoke test)

| When | Do | Goal |
|---|---|---|
| Day 0 | Site live, migration applied, submit sitemap in Google Search Console and Bing Webmaster Tools | Indexing starts |
| Day 0 | Post on LinkedIn and X (founder story below) | First 20 sign-ups from your network |
| Day 1–3 | Reddit: one helpful post per community, not a link drop (rules below) | Real users from the two target verticals |
| Day 2 | Indie Hackers + r/SideProject launch post | Early adopters, feedback |
| Day 3–7 | Directory submissions (list below), 3–4 a day | Backlinks for SEO |
| Day 7 | $20 smoke test: Google Search, exact match "call recording for contractors", "real estate call notes" | Does a cold visitor join? Target ≥10% visit→waitlist |
| Week 2 | Product Hunt, only after ≥50 waitlist sign-ups to notify | Launch day spike |

## LinkedIn (founder post)

> Most small-business deals still happen on the phone. The price, the delivery date, who promised what: it's all said once and then lost.
>
> Your phone can record calls now. It can't remember them.
>
> So I built Dimts: a business phone line that writes down what everyone promised. After each call you get the agreed prices and dates (each linked to the second it was said), a list of what you owe and what you're waiting on per customer, and a drafted follow-up email.
>
> Every call starts with a recording notice, and where the law asks for it, both people press 1. No covert recording.
>
> It works in your browser today, from $20 a month with a 21-day free trial. The iPhone and Android apps are next; the waitlist is here: https://dimts-site.vercel.app/?ref=linkedin
>
> If you sell by phone (agents, contractors, suppliers, brokers), I'd love 15 minutes of your honest feedback.

## X / Threads (thread)

1. Your phone can record calls now. It can't remember them. I built a phone line that does. 🧵
2. After every call, Dimts writes down: what was agreed (each price and date links to the second it was said), what you owe, what you're waiting on, and a drafted follow-up.
3. Promises carry across every call with that person. "Who am I still waiting on this week?" gets an answer with links to the calls.
4. Consent first: a spoken notice before anyone talks; both people press 1 where the law requires it (Gulf, Germany, Austria).
5. Works in the browser now. Apps waitlist: https://dimts-site.vercel.app/?ref=x

## Reddit (read each sub's self-promo rule first; most allow it only in weekly threads or as a helpful answer)

**r/realtors** (weekly self-promo thread, or a discussion post without the link):
Title: How do you keep track of what clients and other agents promise on the phone?
> I'm building a tool for this and want to check I'm solving a real problem. Between showings I take a lot of calls, and things like "the seller will fix the roof" or "pre-approval by Friday" get lost. Right now I'm recording calls with a consent notice and pulling out the promises per person. How do you handle it today: notes app, CRM, memory? (Happy to share what I built if anyone wants to try it.)

**r/Contractor**, **r/HVAC**, **r/electricians** (same approach, the angle is quotes agreed by phone):
Title: Ever lost money on a price you agreed over the phone?
> "$4,000 all in" vs "$4,000 plus materials". How do you protect yourself: follow-up text, email, nothing? I built a phone line that records with a notice and lists the agreed price and extras after the call; looking for 5 contractors to try it free and tell me what's wrong with it.

**r/smallbusiness**, **r/Entrepreneur**: share the consent guide (https://dimts-site.vercel.app/record-business-calls-with-consent?ref=reddit-smb) as a useful answer whenever someone asks whether they can record calls. Don't post it cold.

## Indie Hackers / r/SideProject

Title: I built a business phone line that remembers what everyone promised
> Problem, demo GIF of the hero sequence, stack (Expo web, Node on Vercel, Telnyx, Whisper/ElevenLabs, Ollama), pricing ($20/$50, 21-day trial), what's next (apps, waitlist). Ask for feedback on the landing page. Link: https://dimts-site.vercel.app/?ref=indiehackers

## Product Hunt (week 2)

- Name: Dimts
- Tagline (60 chars): The phone line that remembers what everyone promised
- Description: Dimts records business calls with a consent notice, then lists what was agreed, what you owe and what you're waiting on, each linked to the second it was said, and drafts the follow-up. Works on any phone, no app needed on the other side.
- Gallery: og.png, the hero recap, the comparison table, the consent notice
- First comment: founder story + "free for 21 days, use code … for 2 months of Pro" (create the Polar discount first)

## Directories (free, dofollow where possible)

Submit with the same name, tagline and description each time:
- BetaList (waitlist-stage products), Launching Next, StartupBase, SaaSHub, AlternativeTo (list Dimts as an alternative to "TapeACall", "Otter.ai", "Quo"), There's An AI For That, Futurepedia, Toolify, G2 and Capterra (free vendor listings), Crunchbase (company profile), Indie Hackers products.

## SEO: keyword → page map

Live now:

| URL | Primary intent | Supporting terms |
|---|---|---|
| / | business phone line that remembers promises | AI call notes, call recording app for business, call summary |
| /real-estate-agents | real estate call notes | call recording for realtors, real estate agent phone app |
| /contractors | call recording for contractors | contractor job notes app, phone quote record |
| /record-business-calls-with-consent | is it legal to record business calls | one-party consent states, two-party consent, recording calls UK GDPR, Germany call recording law |

Next pages (one intent each; write only when there's real content):
1. `/suppliers` (order calls, quantities, delivery dates)
2. `/insurance-brokers`
3. `/vs/tapeacall`, `/vs/otter`: honest comparisons; these rank fast and convert
4. `/business-phone-number`: second number for your business that records with consent
5. `/call-recording-uk`, `/call-recording-germany`: country consent explainers (localised, English)

Technical follow-ups once the domain is live: verify both Search Console properties, submit `sitemap.xml`, check the rich result for the FAQ on the home page, and keep `lastmod` updated when pages change.
