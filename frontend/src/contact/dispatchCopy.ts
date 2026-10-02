import type { DispatchReason, DispatchState } from '../api/contact'

// French copy of « will a scheduled message really leave? » (Contact port S9, Human report of 2026-10-02: a message
// scheduled while the automatic sending was off never left, and nothing said so). Shared by the Contact banner, the
// mail editor, the schedule confirmation and Paramètres › Connexions › Envoi programmé.

// Where every reason is fixed: Paramètres › Connexions (the Envoi programmé card or the CIRCOE Toolbox card).
export const CONNECTIONS_PATH = '/settings/connections'

const REASONS: Record<DispatchReason, { badge: string; why: string; link: string }> = {
  disabled: {
    badge: 'Ne partira pas : envoi automatique désactivé',
    why: 'l’envoi automatique des mails programmés est désactivé',
    link: 'Activer l’envoi automatique',
  },
  toolbox_disabled: {
    badge: 'Ne partira pas : Toolbox non connectée',
    why: 'CIRCOE Toolbox n’est pas connectée',
    link: 'Connecter CIRCOE Toolbox',
  },
  toolbox_not_configured: {
    badge: 'Ne partira pas : Toolbox non configurée',
    why: 'CIRCOE Toolbox n’est pas configurée',
    link: 'Configurer CIRCOE Toolbox',
  },
  toolbox_disconnected: {
    badge: 'Ne partira pas : Toolbox non connectée',
    why: 'CIRCOE Toolbox n’est pas connectée',
    link: 'Connecter CIRCOE Toolbox',
  },
  toolbox_expired: {
    badge: 'Ne partira pas : connexion Toolbox expirée',
    why: 'la connexion à CIRCOE Toolbox a expiré',
    link: 'Reconnecter CIRCOE Toolbox',
  },
  not_running: {
    badge: 'Ne partira pas : envoi automatique arrêté',
    why: 'l’envoi automatique ne tourne pas sur le serveur VIPER (voir ses journaux)',
    link: 'Voir les connexions',
  },
}

// An unknown reason (a newer server) still reads as « will not leave ».
export function reasonCopy(reason: DispatchReason | null): { badge: string; why: string; link: string } {
  return (reason && REASONS[reason]) || REASONS.not_running
}

const NUMBER = new Intl.NumberFormat('fr-FR')

// The Contact page banner: « 2 messages programmés ne partiront pas : … ».
export function bannerText(dispatch: DispatchState): string {
  const count = dispatch.scheduled_count
  const head =
    count > 1
      ? `${NUMBER.format(count)} messages programmés ne partiront pas`
      : '1 message programmé ne partira pas'
  const overdue =
    dispatch.overdue_count > 0
      ? dispatch.overdue_count > 1
        ? ` ${NUMBER.format(dispatch.overdue_count)} ont déjà dépassé leur heure : au-delà du retard toléré, ils reviendront à « Validé » sans partir et devront être reprogrammés.`
        : ' 1 a déjà dépassé son heure : au-delà du retard toléré, il reviendra à « Validé » sans partir et devra être reprogrammé.'
      : ''
  return `${head} : ${reasonCopy(dispatch.reason).why}.${overdue}`
}

// The sentence of the editor and of the schedule confirmation for an inactive sending.
export function inactiveSentence(reason: DispatchReason | null): string {
  return `Envoi automatique inactif : ${reasonCopy(reason).why}. La date est enregistrée, mais aucun mail ne part tant que ce n’est pas réglé dans Paramètres › Connexions.`
}
