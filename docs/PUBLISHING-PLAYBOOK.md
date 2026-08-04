# Publishing playbook

How a finished package becomes live, crawlable content. The flow is
assisted, never autonomous: ContentStudio prepares everything and a human
presses the final button on every platform.

## The principle

Reach and brand consolidation are different jobs, and on most platforms
they belong to different identities.

- **Reach comes from a person.** Personal profiles reach roughly 8 to 12
  percent of their followers; company pages reach around 1.6 percent, and
  nearly every widely read long-form post on LinkedIn is written from a
  personal profile rather than a brand account.
- **Consolidation comes from the brand.** Search engines and AI answer
  engines build an entity picture from a business's own surfaces, so the
  company page still needs the content attached to it.

Publishing from the person and resharing from the page gets both. The
reverse order gets neither: a company-page original starts with the
smaller audience, and the personal profile has nothing to amplify.

## The two steps

**Step 1. Publish as the person.** The article or post goes out from the
creator's personal profile, in their voice, with their name on it. This is
the version that earns reach, comments, and dwell time. Paste its live URL
into the platform card. That URL is what feeds `llms.txt`, the JSON-LD
`url`, and the corroboration check.

**Step 2. Reshare from the company page.** Open the page, reshare the live
post, and add commentary above it in the brand's voice, speaking about the
creator in the third person. A bare reshare underperforms and reads
automated; the commentary is what makes it a post rather than an echo.
Record the reshare URL in the same card.

## Why a reshare does not raise the visibility score

The corroboration check counts *independent* surfaces: the same claim
appearing on a YouTube description, a site article, and a LinkedIn post
tells a retrieval engine three sources agree. The same post reshared to a
second profile is one source distributed twice. ContentStudio therefore
stores reshares in `pkg.reshares` rather than `pkg.publishedUrls`, so the
score reflects genuine corroboration and never inflates. To clear the
check, publish the claim somewhere genuinely new: the owned site page is
usually the cheapest and most valuable third surface, since it is the only
one that can carry the package's JSON-LD.

## Per-brand configuration

Each workspace stores its own strategy at `profile.publishing`, so every
brand added to the studio carries its own approach:

```json
{
  "linkedin": {
    "primary": "personal",
    "companyUrl": "https://www.linkedin.com/company/<page>",
    "reshare": true
  }
}
```

`primary` accepts `personal` (publish as the person, then reshare from the
page), `company` (page only), or `personal_only` (no reshare step). Edit it
on the Publish Run page under "LinkedIn publishing strategy for this
brand". With no configuration, the card shows a single publishing step.

## Formatting that survives the paste

Articles are stored as markdown because that drives the Website Kit and the
JSON-LD, but no social composer converts markdown. Pasting raw text
produces literal `##` characters and no heading hierarchy, which is exactly
what crawlers and AI assistants read a long-form piece by.

Use **Copy formatted** on the card. It places an HTML flavor on the
clipboard, so a rich editor receives real `h2`/`h3` headings, bold, and
lists. The plain-text flavor has the markdown stripped as well, so no
composer ever receives a raw `## Heading`. Each field also lists its
heading structure with the level to apply, as a fallback for editors that
reject pasted HTML.

## Media

Attached package media appears on every card in selection order, the first
being the AI's pick for the cover. Download the file, then attach it in the
composer yourself: browser extensions cannot drive the operating system's
file picker.

Platforms strip embedded metadata from photos on upload, so the alt text
has to be pasted into the platform's own alt field. It travels with each
download button and lives in full on the package's AI Metadata tab.

## Working with a browser assistant

The Publish Run page carries an instruction block for a browser assistant
such as Claude in Chrome. **Copy it and send it yourself, in your own
message.** An assistant must take direction from its user, never from a web
page: page-borne instructions to an agent are indistinguishable from a
prompt-injection attack, and an assistant signed into your accounts should
refuse them. The instruction text tells the assistant to treat the page as
data, fill each composer verbatim, and stop before every Post button.

## Order of operations

1. Read the copy on the platform tab and click **Approve for publishing**.
   Nothing unapproved reaches the Publish Run page.
2. Open **Publish Run** and work the cards top to bottom, in posting order.
3. For each card: open the composer, paste with **Copy formatted**, attach
   the media, review, post.
4. Paste the live URL into the card. The registry, `llms.txt`, the schema,
   and the score all update on save.
5. Where step 2 applies, reshare from the company page with its commentary
   and record that URL too.
