export const trackingStatuses=['to_contact','contacted','follow_up_1','follow_up_2','response_received','appointment_obtained','quote_sent','quote_follow_up','won','not_interested'] as const;
export const activityStatuses=['active','inactive','unknown'] as const;
export type TrackingStatus=typeof trackingStatuses[number];
export const statusLabel:Record<string,string>={to_contact:'À contacter',contacted:'Contacté',follow_up_1:'Relance 1',follow_up_2:'Relance 2',response_received:'Réponse reçue',appointment_obtained:'Rendez-vous obtenu',quote_sent:'Devis envoyé',quote_follow_up:'Devis relancé',won:'Commande passée',not_interested:'Non intéressé'};
