"""Does an e-mail address belong to the person it is attached to? The one owner of that question
(`doc/features/email-identity.md`).

An address is **doubtful** for a person when it plainly looks like someone else's:

1. `colleague_name`: its local part is the name of another prospect of the same company, and the
   person's own family name is not in it;
2. `shared_address`: another prospect holds the same address (when the address spells the person's
   family name and no other holder's, that person is not doubted);
3. `named_other`: its local part has the shape of a person's name (`first.last`, `f.last`) with
   neither the person's first name or initial nor the beginning of their family name.

A generic mailbox (`contact@`, `info@`, `service.client@`…) is nobody's and is never doubted, nor
is a local part naming the company. The rules are deliberately lenient (a nickname, a maiden name
with the right initial, a truncated name pass): a doubt must be rare, and a person dismisses a
wrong one with `confirm`, recorded per (person, address) with who and when. The doubt is computed
from the current rows, never stored: it ends as soon as the address or the name is corrected, and a
confirmation goes with the address (`forget`).

A doubtful recipient blocks generation, validation, scheduling and sending (`message_doubts`,
`warehouse_doubt`), whatever the address's verification status says. Unlike
`app.services.eligibility`, nothing is cancelled: the message waits to be corrected. Operations
flush; the caller owns the transaction. Logs and audit carry ids and codes, never an address.
"""

import logging
import re
import unicodedata
import uuid
from collections import defaultdict
from collections.abc import Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum

from sqlalchemy import ColumnElement, delete, select, text
from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.models import Company, Email, EmailIdentityConfirmation, Prospect, WarehouseDraft
from app.services import audit
from app.services.errors import ActorNotAllowedError, InvalidFieldError, NotFoundError

logger = logging.getLogger(__name__)

# The API refusal code, the dispatcher's `last_error_code` and the warehouse `failure_code`.
CODE = "email_identity_doubt"
MESSAGE = "A recipient address looks like someone else's: correct it, or confirm it is theirs."


class Reason(StrEnum):
    COLLEAGUE = "colleague_name"
    SHARED = "shared_address"
    NAMED_OTHER = "named_other"


# French wording (CLI listing).
LABELS: dict[Reason, str] = {
    Reason.COLLEAGUE: "au nom d’un autre prospect de l’entreprise",
    Reason.SHARED: "même adresse sur une autre fiche",
    Reason.NAMED_OTHER: "au nom de quelqu’un d’autre",
}

# Words of a mailbox that is nobody's.
_GENERIC_WORDS = """
    accueil achat achats adm admin administratif administration adv agence appro approvisionnement
    atelier bonjour bureau cabinet candidature cdg cial client clients clientele commande
    commandes commercial commerciale communication compta comptabilite contact contacts courrier
    customer depot devis dg direction directeur directrice dispatch dpo drh entrepot expedition
    expeditions export exploitation facturation facture factures finance france general generale
    gestion hello hr import info infos information informations international juridique livraison
    livraisons logistic logistics logistique magasin mail mailbox marketing no noreply office
    operations ops paie planning plateforme presse qhse qualite quai quote recrutement reception
    reply rgpd rh sales secretariat securite service services siege site societe standard stock
    stocks support technique team transit transport transports travaux vente ventes web webmaster
"""
GENERIC = frozenset(_GENERIC_WORDS.split())
# Name words too common to say anything.
PARTICLES = frozenset(
    {"de", "du", "des", "le", "la", "les", "van", "von", "den", "der", "el", "al"}
)
CIVILITIES = frozenset({"m", "mr", "mme", "mlle", "dr", "monsieur", "madame", "mademoiselle"})
LIGATURES = str.maketrans({"œ": "oe", "æ": "ae", "ß": "ss", "ø": "o", "đ": "d", "ł": "l"})


def fold(text: str) -> str:
    """Lowercase, without accents."""
    decomposed = unicodedata.normalize("NFKD", text.lower().translate(LIGATURES))
    return "".join(c for c in decomposed if not unicodedata.combining(c))


def words(text: str | None) -> tuple[str, ...]:
    return tuple(re.findall(r"[a-z]+", fold(text or "")))


@dataclass(frozen=True, slots=True)
class Name:
    first: tuple[str, ...] = ()
    last: tuple[str, ...] = ()

    @classmethod
    def of(cls, first_name: str | None, last_name: str | None) -> Name:
        return cls(words(first_name), words(last_name))

    @classmethod
    def full(cls, value: str | None) -> Name:
        """A single « Civility First Last » field."""
        found = tuple(word for word in words(value) if word not in CIVILITIES)
        return cls(found[:-1], found[-1:])


def local_words(address: str) -> tuple[str, ...]:
    """The alphabetic words of the local part (digits and `+tag` aside)."""
    return words(address.partition("@")[0].partition("+")[0])


def is_generic(address: str) -> bool:
    found = local_words(address)
    return not found or any(word in GENERIC for word in found)


def _has_family_name(local: tuple[str, ...], name: Name) -> bool:
    """The family name (a whole word of it, or all of them joined) is spelt in the local part."""
    compact = "".join(local)
    joined = "".join(name.last)
    if len(joined) >= 3 and joined in compact:
        return True
    return any(
        (len(word) >= 3 and word in compact) or (len(word) == 2 and word in local)
        for word in name.last
        if word not in PARTICLES
    )


def _resembles(local: tuple[str, ...], name: Name) -> bool:
    """Anything of the person's name in the local part (lenient)."""
    if _has_family_name(local, name):
        return True
    compact = "".join(local)
    for word in name.first:
        if (len(word) >= 3 and word in compact) or (len(word) == 2 and word in local):
            return True
    # Truncated: the first letters of the family name, or a shortened first name.
    if any(len(word) > 4 and word[:4] in compact for word in name.last):
        return True
    if any(len(w) >= 3 and first.startswith(w) for w in local for first in name.first):
        return True
    # Initials (`jp`, `jpd`), or the first name's initial leading (`j.maiden-name`).
    initials = "".join(word[0] for word in name.first)
    both = initials + "".join(word[0] for word in name.last)
    if any(len(w) >= 2 and w in (initials, both) for w in local):
        return True
    return bool(initials) and len(local) > 1 and len(local[0]) == 1 and local[0] == initials[0]


def _spells(local: tuple[str, ...], name: Name) -> bool:
    """The local part is exactly this name: `last`, `first.last`, `f.last`, in either order."""
    first, last = "".join(name.first), "".join(name.last)
    if not first or len(last) < 3:
        return False
    forms = {first + last, last + first}
    for initial in (first[0], "".join(word[0] for word in name.first)):
        forms |= {initial + last, last + initial}
    if len(last) >= 4:
        forms.add(last)
    return "".join(local) in forms


@dataclass(frozen=True, slots=True)
class Person:
    prospect_id: uuid.UUID | None
    name: Name
    display: str = ""


@dataclass(frozen=True, slots=True)
class Doubt:
    address: str
    reason: Reason
    # The other person the address points to (`colleague_name`, `shared_address`).
    other_name: str | None = None
    other_id: uuid.UUID | None = None


def assess(
    address: str,
    name: Name,
    *,
    colleagues: Iterable[Person] = (),
    holders: Iterable[Person] = (),
    company_words: Collection[str] = (),
) -> Doubt | None:
    """The pure rule. `colleagues`: the other prospects of the company; `holders`: the other
    prospects holding the same address."""
    if is_generic(address):
        return None
    local = local_words(address)
    mine = _has_family_name(local, name)
    if not mine:
        for other in colleagues:
            if _spells(local, other.name):
                return Doubt(address, Reason.COLLEAGUE, other.display, other.prospect_id)
    others = list(holders)
    if others and (not mine or any(_has_family_name(local, o.name) for o in others)):
        return Doubt(address, Reason.SHARED, others[0].display, others[0].prospect_id)
    if (
        name.first
        and name.last
        and 2 <= len(local) <= 4
        and max(map(len, local)) >= 3
        and not any(len(w) >= 3 and w in company_words for w in local)
        and not _resembles(local, name)
    ):
        return Doubt(address, Reason.NAMED_OTHER)
    return None


# --- reads ----------------------------------------------------------------------------------------


def _key(prospect_id: uuid.UUID) -> str:
    return f"prospect:{prospect_id}"


def _name_key(contact_name: str) -> str:
    return f"name:{' '.join(words(contact_name))}"[:600]


@dataclass(frozen=True, slots=True)
class _Known:
    person: Person
    company_id: uuid.UUID | None
    company_words: frozenset[str]


def _known(session: Session, condition: ColumnElement[bool]) -> list[_Known]:
    rows = session.execute(
        select(
            Prospect.id,
            Prospect.first_name,
            Prospect.last_name,
            Prospect.company_id,
            Company.display_name,
            Company.legal_name,
        )
        .outerjoin(Company, Company.id == Prospect.company_id)
        # Members are in the base as people, never prospected.
        .where(Prospect.member_user_id.is_(None), condition)
        .order_by(Prospect.last_name, Prospect.first_name, Prospect.id)
    ).tuples()
    return [
        _Known(
            Person(pid, Name.of(first, last), " ".join(p for p in (first, last) if p)),
            company_id,
            frozenset((*words(display), *words(legal))),
        )
        for pid, first, last, company_id, display, legal in rows
    ]


def confirmations(
    session: Session, keys: Collection[str]
) -> dict[tuple[str, str], EmailIdentityConfirmation]:
    if not keys:
        return {}
    rows = session.scalars(
        select(EmailIdentityConfirmation).where(EmailIdentityConfirmation.person_key.in_(keys))
    )
    return {(row.person_key, row.address): row for row in rows}


def confirmations_of(
    session: Session, prospect_id: uuid.UUID
) -> dict[str, EmailIdentityConfirmation]:
    """The prospect's confirmations, by address."""
    found = confirmations(session, [_key(prospect_id)])
    return {address: row for (_, address), row in found.items()}


type Pair = tuple[uuid.UUID, str]


def pair_doubts(session: Session, pairs: Collection[Pair]) -> dict[Pair, Doubt]:
    """The unconfirmed doubts among these (prospect, address) pairs, in a handful of statements.
    The address need not be on record for the person (a recipient typed on a message)."""
    if not pairs:
        return {}
    ids = {prospect_id for prospect_id, _ in pairs}
    targets = {k.person.prospect_id: k for k in _known(session, Prospect.id.in_(ids))}
    companies = {t.company_id for t in targets.values() if t.company_id is not None}
    colleagues: dict[uuid.UUID, list[Person]] = defaultdict(list)
    if companies:
        for found in _known(session, Prospect.company_id.in_(companies)):
            assert found.company_id is not None
            colleagues[found.company_id].append(found.person)
    held = session.execute(
        select(Email.address, Email.prospect_id).where(
            Email.address.in_({address for _, address in pairs}), Email.is_active
        )
    ).tuples()
    holder_ids: dict[str, set[uuid.UUID]] = defaultdict(set)
    for address, prospect_id in held:
        holder_ids[address].add(prospect_id)
    others = {i for found_ids in holder_ids.values() for i in found_ids} - ids
    people = dict(targets)
    if others:
        people.update({k.person.prospect_id: k for k in _known(session, Prospect.id.in_(others))})
    confirmed = confirmations(session, [_key(i) for i in ids])
    out: dict[Pair, Doubt] = {}
    for prospect_id, address in pairs:
        target = targets.get(prospect_id)
        if target is None or (_key(prospect_id), address) in confirmed:
            continue
        company = target.company_id
        doubt = assess(
            address,
            target.person.name,
            colleagues=[
                c
                for c in (colleagues.get(company, []) if company else [])
                if c.prospect_id != prospect_id
            ],
            holders=sorted(
                (
                    people[i].person
                    for i in holder_ids.get(address, ())
                    if i != prospect_id and i in people
                ),
                key=lambda p: (p.display, str(p.prospect_id)),
            ),
            company_words=target.company_words,
        )
        if doubt is not None:
            out[(prospect_id, address)] = doubt
    return out


def base_doubts(
    session: Session, prospect_ids: Collection[uuid.UUID] | None = None
) -> dict[Pair, Doubt]:
    """The unconfirmed doubts of the active addresses on record: of these people, or of the whole
    base (the review queue and the operator's listing)."""
    if prospect_ids is not None and not prospect_ids:
        return {}
    statement = select(Email.prospect_id, Email.address).where(Email.is_active)
    if prospect_ids is not None:
        statement = statement.where(Email.prospect_id.in_(prospect_ids))
    return pair_doubts(session, set(session.execute(statement).tuples()))


# What the whole-base doubts are computed from. `ctid` and `xmin` change with every row written
# or removed (raw SQL included), so equal fingerprints mean equal rows.
_FINGERPRINT = text(
    " UNION ALL ".join(
        f"SELECT count(*), coalesce(sum(hashtextextended(ctid::text || xmin::text, 0)), 0) "
        f"FROM {table}"
        for table in ("prospects", "emails", "companies", "email_identity_confirmations")
    )
)


@dataclass(frozen=True, slots=True)
class BaseDoubts:
    """The unconfirmed doubts of the whole base, and the e-mail rows they are about."""

    pairs: Mapping[Pair, Doubt]
    email_ids: frozenset[uuid.UUID]


_whole_base: tuple[tuple[object, ...], BaseDoubts] | None = None


def whole_base(session: Session) -> BaseDoubts:
    """What lists and counters read. Assessed again only when the rows behind it changed (one
    cheap statement tells), so a polled screen does not assess every address each time."""
    global _whole_base
    fingerprint = tuple(session.execute(_FINGERPRINT).tuples())
    cached = _whole_base
    if cached is None or cached[0] != fingerprint:
        pairs = base_doubts(session)
        rows = (
            session.execute(
                select(Email.id, Email.prospect_id, Email.address).where(
                    Email.address.in_({address for _, address in pairs})
                )
            ).tuples()
            if pairs
            else ()
        )
        found = BaseDoubts(pairs, frozenset(i for i, p, a in rows if (p, a) in pairs))
        cached = _whole_base = (fingerprint, found)
        logger.info("email_identity.assessed_base doubts=%s", len(pairs))
    return cached[1]


def doubtful_ids(session: Session) -> set[uuid.UUID]:
    """The people with a doubtful active address."""
    return {prospect_id for prospect_id, _ in whole_base(session).pairs}


def primary_doubts(session: Session, prospect_ids: Collection[uuid.UUID]) -> dict[uuid.UUID, Doubt]:
    """For lists: the doubt of each person who has one, the primary address's first."""
    wanted = set(prospect_ids)
    base = whole_base(session).pairs if wanted else {}
    found = {pair: doubt for pair, doubt in base.items() if pair[0] in wanted}
    if not found:
        return {}
    primaries = set(
        session.execute(
            select(Email.prospect_id, Email.address).where(
                Email.prospect_id.in_({i for i, _ in found}), Email.is_primary
            )
        ).tuples()
    )
    out: dict[uuid.UUID, Doubt] = {}
    for pair, doubt in sorted(found.items(), key=lambda item: item[0] not in primaries):
        out.setdefault(pair[0], doubt)
    return out


def message_doubts(
    session: Session,
    prospect_id: uuid.UUID,
    to: Sequence[str],
    copies: Sequence[str] = (),
) -> list[Doubt]:
    """The doubts of a message's recipients: every `To` address (on record or typed), and the
    copies that are the person's own addresses (a colleague in copy is a choice)."""
    own = (
        set(session.scalars(select(Email.address).where(Email.prospect_id == prospect_id)))
        if copies
        else set()
    )
    addresses = list(dict.fromkeys([*to, *(a for a in copies if a in own)]))
    found = pair_doubts(session, {(prospect_id, address) for address in addresses})
    return [found[(prospect_id, a)] for a in addresses if (prospect_id, a) in found]


def warehouse_doubt(session: Session, draft: WarehouseDraft) -> Doubt | None:
    """A warehouse mail goes to a snapshot address in the name of a warehouse contact: doubtful
    when the address plainly names someone else than that contact, or when it is doubtful for
    every prospect holding it. A confirmation for the contact, or for a holder, dismisses it."""
    return warehouse_doubts(session, [draft]).get(draft.id)


def warehouse_doubts(session: Session, drafts: Sequence[WarehouseDraft]) -> dict[uuid.UUID, Doubt]:
    """`warehouse_doubt` of many drafts (the polled list) in a handful of statements."""
    recipients = {
        draft.id: held for draft in drafts if (held := (draft.recipient or "").strip().lower())
    }
    if not recipients:
        return {}
    holders: dict[str, set[uuid.UUID]] = defaultdict(set)
    active: set[Pair] = set()
    for address, prospect_id, is_active in session.execute(
        select(Email.address, Email.prospect_id, Email.is_active).where(
            Email.address.in_(set(recipients.values()))
        )
    ).tuples():
        holders[address].add(prospect_id)
        if is_active:
            active.add((prospect_id, address))
    keys = {
        draft.id: [
            _name_key(draft.contact_name),
            *(_key(i) for i in holders.get(recipients[draft.id], ())),
        ]
        for draft in drafts
        if draft.id in recipients
    }
    confirmed = set(confirmations(session, {key for found in keys.values() for key in found}))
    out: dict[uuid.UUID, Doubt] = {}
    unnamed: list[WarehouseDraft] = []
    for draft in drafts:
        recipient = recipients.get(draft.id)
        if recipient is None or any((key, recipient) in confirmed for key in keys[draft.id]):
            continue
        named = assess(recipient, Name.full(draft.contact_name))
        if named is not None:
            out[draft.id] = named
        elif holders.get(recipient):
            unnamed.append(draft)
    # An active holder the whole-base read does not doubt clears the draft without more reads.
    if unnamed:
        cleared = active - whole_base(session).pairs.keys()
        unnamed = [
            d
            for d in unnamed
            if not any((i, recipients[d.id]) in cleared for i in holders[recipients[d.id]])
        ]
    found = pair_doubts(
        session,
        {(i, recipients[d.id]) for d in unnamed for i in holders[recipients[d.id]]},
    )
    for draft in unnamed:
        recipient = recipients[draft.id]
        pairs = [(i, recipient) for i in holders[recipient] if (i, recipient) in found]
        if len(pairs) == len(holders[recipient]):
            out[draft.id] = found[min(pairs, key=lambda pair: str(pair[0]))]
    return out


# --- writes ---------------------------------------------------------------------------------------


def _record(
    session: Session,
    actor: ActorContext,
    key: str,
    address: str,
    prospect_id: uuid.UUID | None,
    subject: tuple[str, uuid.UUID],
) -> None:
    if actor.type is not ActorType.HUMAN or not actor.id:
        raise ActorNotAllowedError("An address is confirmed as someone's by a person.")
    if (key, address) in confirmations(session, [key]):
        return
    row = EmailIdentityConfirmation(
        prospect_id=prospect_id,
        person_key=key,
        address=address,
        confirmed_by_id=actor.id,
        confirmed_by_display=actor.display,
    )
    session.add(row)
    session.flush()
    audit.record_event(
        session,
        actor,
        "email_identity.confirmed",
        entity_type="email_identity_confirmation",
        entity_id=row.id,
        subject=subject,
    )
    logger.info("email_identity.confirmed subject=%s id=%s", *subject)


def confirm(session: Session, actor: ActorContext, prospect_id: uuid.UUID, address: str) -> None:
    """A person says this address is really this prospect's (a repeat changes nothing)."""
    if session.get(Prospect, prospect_id) is None:
        raise NotFoundError("Unknown prospect.")
    value = address.strip().lower()
    if "@" not in value or len(value) > 320:
        raise InvalidFieldError("address", "Invalid e-mail address.", "format")
    _record(session, actor, _key(prospect_id), value, prospect_id, ("prospect", prospect_id))


def revoke(session: Session, actor: ActorContext, prospect_id: uuid.UUID, address: str) -> None:
    """A person takes a confirmation back: the address is doubted again."""
    if actor.type is not ActorType.HUMAN or not actor.id:
        raise ActorNotAllowedError("A confirmation is taken back by a person.")
    forget(session, actor, prospect_id, [address.strip().lower()])


def forget(
    session: Session, actor: ActorContext, prospect_id: uuid.UUID, addresses: Collection[str]
) -> int:
    """Remove the confirmations of addresses that left the person, or that are taken back."""
    if not addresses:
        return 0
    gone = list(
        session.scalars(
            delete(EmailIdentityConfirmation)
            .where(
                EmailIdentityConfirmation.person_key == _key(prospect_id),
                EmailIdentityConfirmation.address.in_(addresses),
            )
            .returning(EmailIdentityConfirmation.id)
        )
    )
    for row_id in gone:
        audit.record_event(
            session,
            actor,
            "email_identity.confirmation_removed",
            entity_type="email_identity_confirmation",
            entity_id=row_id,
            subject=("prospect", prospect_id),
        )
    return len(gone)
