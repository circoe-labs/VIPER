import { defineConfig } from 'vitest/config'; import react from '@vitejs/plugin-react';
export default defineConfig({plugins:[react()],server:{port:5173,proxy:{'/api':'http://localhost:3001'}},build:{outDir:'dist-client'},
  // `npm test` ne collecte que les tests de l'application (Express + SQLite + React) : les dossiers legacy `frontend/` et `backend/`
  // (ancienne pile, hors périmètre) ont leurs propres outils et ne sont ni lancés ni modifiés ici.
  test:{include:['tests/**/*.test.ts'],exclude:['**/node_modules/**','frontend/**','backend/**','dist-client/**','dist-server/**']}});
