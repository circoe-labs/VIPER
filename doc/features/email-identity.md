# E-mail identity: does the address belong to the person?

One owner: `backend/app/services/email_identity.py`. A doubt is **computed** from the current rows
(nothing is stored or rewritten), so data already in the base is covered the day it is deployed,
and a doubt ends as soon as the address or the name is corrected.

## When an address is doubtful

| Reason | Rule |
| --- | --- |
| `colleague_name` | The local part spells another prospect of the same company (`last`, `first.last`, `f.last`, either order) and does not contain the person's family name. |
| `shared_address` | Another prospect holds the same active address. When the address spells the person's family name and no other holder's, that person is not doubted. Two records it names equally (a duplicate) are both doubted. |
| `named_other` | The local part has the shape of a name (2 to 4 words separated by `.`, `_`, `-`) and carries neither the first name, its beginning or initial, nor the family name or its first four letters. Needs both names on the sheet. |

Never doubted: generic mailboxes (`contact@`, `info@`, `service.client@`…, list `GENERIC`), a local
part naming the company, accents, compound names and particles, initials, a maiden name carried
with the right first name or initial. The rule is lenient on purpose: it misses some cases (a
single unknown word, a wrong address starting with the right initial) rather than crying wolf.
Member fiches are ignored.

## Override

« C'est bien son adresse » (`POST /prospects/{id}/email-identity`, `…/revoke`; warehouse mails:
`POST /warehouses/drafts/{id}/confirm-recipient`) records who and when, per (person, address), in
`email_identity_confirmations` (migration 0064), with the audit events
`email_identity.confirmed` / `.confirmation_removed`. Only a signed-in person may. The
confirmation is removed when the address leaves the person (`contact_recipients`), so a changed
address is asked again, also if it later comes back.

## Where it applies

- « Vérifié » on the sheet: refused (422, `identity_doubt` on `emails.N.verified_now`) unless the
  save carries `identity_confirmed`. Database explorer: same refusal when a row is marked
  verified; a changed address goes back to unverified.
- Accepting an agent's proposal: the address is saved **unverified** when doubtful.
- Import: imported addresses are always unverified; the flag appears at once.
- Contact: AI drafting, validation, scheduling, series (counted apart), « Recréer le brouillon »
  and the remote-draft retry answer 409 `email_identity_doubt`; the dispatcher checks again before
  claiming and sends the mail back to Validé (`email_identity_doubt`). Recipients checked are
  those the message really holds: every `To`, and the copies that are the person's own addresses.
  A person may still write or edit a draft (to correct it) and declare a send already made.
- Warehouse mails (preprogramming, validation, scheduling, recovery, dispatch): doubtful when the
  address plainly names someone else than the warehouse contact, or is doubtful for every prospect
  holding it.
- File status: a doubtful address never counts as a verified e-mail, whatever its stored status: the
  « État de la fiche » card (completeness and its score), the review (verified / usable /
  incomplete) of the lists and counters, and the company and warehouse statuses that need a usable
  person. The stored status, and the e-mail filters that read it, are unchanged.

Unlike `eligibility`, nothing is cancelled: the block is about one address, not about the person,
who stays in every list. `QualityAlert` does not own it: an alert is a stored opinion that a person
resolves, while this flag must follow the data and exist without any write.

## Cost

Lists and counters read `whole_base`: the whole base is assessed again only when a row of
`prospects`, `emails`, `companies` or `email_identity_confirmations` changed (one fingerprint
statement says so). The warehouse list assesses its drafts in a handful of statements.

## Seeing them

Badge « Identité e-mail à vérifier » on the Prospection list, the Contact lists, the sheet
(the address reads « Identité à vérifier » even when it was marked verified), the mail editor and
the warehouse drafts. Review queue: Prospection filter « Identité e-mail à vérifier »
(`?identity_doubt=true`; `identity_doubts` in the counters).

Operator, read only, from `backend/`:

```sh
python -m app.cli email-identity
```

Tab-separated: prospect id, name, company, address, primary, verification status, reason, other
person. It prints personal data on the terminal: keep the output off the repository.
