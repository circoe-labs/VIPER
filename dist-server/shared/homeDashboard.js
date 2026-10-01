/** Catégories du camembert du mois : état courant posé par un humain depuis le 1er du mois (UTC). */
export const monthOutcomeKeys = ['sequence', 'response_received', 'appointment_obtained', 'failure', 'ignored'];
export const monthOutcomeStates = {
    sequence: ['contacted', 'r1', 'r2'], response_received: ['response_received'], appointment_obtained: ['appointment_obtained'],
    failure: ['failure'], ignored: ['ignored']
};
