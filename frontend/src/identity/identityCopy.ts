import type { IdentityDoubt } from '../api/emailIdentity'

export function identitySentence(doubt: Pick<IdentityDoubt, 'reason' | 'other_name'>): string {
  const other = doubt.other_name?.trim()
  switch (doubt.reason) {
    case 'colleague_name':
      return `Adresse au nom de ${other || 'un autre prospect'}, de la même entreprise.`
    case 'shared_address':
      return `Même adresse sur la fiche de ${other || 'un autre prospect'}.`
    case 'named_other':
      return 'Adresse au nom de quelqu’un d’autre.'
  }
}
