/** Features that cannot work with YouTube sources. Shown to the user, never simulated. */
export const UNAVAILABLE_WITH_YOUTUBE: { name: string; why: string }[] = [
  { name: 'BPM e beatmatching', why: "YouTube non permette di accedere all'audio del video." },
  { name: 'Tonalità musicale', why: "Richiede l'analisi dell'audio, non consentita su YouTube." },
  { name: 'EQ di transizione sui bassi', why: "L'audio dei player YouTube non è elaborabile." },
  { name: 'Limitatore dei picchi e gain automatico', why: 'Il volume è regolabile solo da 0 a 100, senza analisi del segnale.' },
  { name: "Forma d'onda e griglia dei battiti", why: 'Servono i dati audio, che YouTube non fornisce.' },
  { name: 'Livello sonoro percepito (loudness)', why: 'Non misurabile senza accesso all’audio.' },
  { name: 'Rilevamento automatico della pubblicità', why: "L'API non espone uno stato pubblicitario affidabile: usa il pulsante «Abbassa volume»." },
];
