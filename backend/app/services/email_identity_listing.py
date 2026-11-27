"""The operator's read-only listing of doubtful addresses (`python -m app.cli email-identity`).

Names and addresses are printed on the operator's terminal only: nothing is logged or written."""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Company, Email, Prospect
from app.services import email_identity


def listing(session: Session) -> str:
    doubts = email_identity.base_doubts(session)
    if not doubts:
        return "No doubtful address."
    rows = session.execute(
        select(
            Prospect.id,
            Prospect.first_name,
            Prospect.last_name,
            Company.display_name,
            Email.address,
            Email.is_primary,
            Email.verification_status,
        )
        .join(Email, Email.prospect_id == Prospect.id)
        .outerjoin(Company, Company.id == Prospect.company_id)
        .where(Prospect.id.in_({prospect_id for prospect_id, _ in doubts}))
        .order_by(Prospect.last_name, Prospect.first_name, Prospect.id, Email.address)
    ).tuples()
    lines = ["prospect_id\tname\tcompany\taddress\tprimary\tstatus\treason\tother"]
    verified = 0
    for prospect_id, first, last, company, address, primary, status in rows:
        doubt = doubts.get((prospect_id, address))
        if doubt is None:
            continue
        verified += status.value == "verified"
        lines.append(
            "\t".join(
                (
                    str(prospect_id),
                    " ".join(part for part in (first, last) if part),
                    company or "",
                    address,
                    "yes" if primary else "no",
                    status.value,
                    doubt.reason.value,
                    doubt.other_name or "",
                )
            )
        )
    lines.append(
        f"{len(lines) - 1} doubtful address(es), {verified} of them marked verified. "
        "Nothing was changed."
    )
    return "\n".join(lines)
