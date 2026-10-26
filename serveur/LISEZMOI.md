# Aube : organisation du code

- `index.html` (à la racine) : toute l'application, publiée sur GitHub Pages.
- `sw.js`, `manifest.webmanifest` : installation comme app et notifications.
- `serveur/worker.js` : la passerelle Cloudflare « aube-ia » (IA Mistral, pas iPhone, Outlook / Google Agenda, notifications).
  - Variables : MISTRAL_API_KEY (secret), MISTRAL_MODEL, FIREBASE_PROJECT_ID, ALLOWED_ORIGIN,
    MS_CLIENT_ID + MS_CLIENT_SECRET (secret), GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET (secret).
  - Liaison KV : STEPS_KV (espace « aube-pas », Europe). Déclencheur cron : */5 * * * *.
- `serveur/firestore.rules` : règles de sécurité Firebase (chaque compte ne voit que ses données).

Aucun secret n'est stocké ici : les clés privées sont uniquement dans Cloudflare.
Les scripts de construction et la source d'origine sont sauvegardés à part (dossier « aube-source »).
