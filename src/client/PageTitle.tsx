import React from 'react';

/** En-tête commun des pages (Accueil, Prospection, Contact, …). */
export const PageTitle = ({ title, sub }: { title: string; sub: string }) => <div className="title"><small>VIPER / V1</small><h1>{title}</h1><p>{sub}</p></div>;
