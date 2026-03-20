# 🌍 Les Délices de l'Afrique — SAV Bot

Agent SAV automatique 24h/24 avec Gmail, Shopify et Telegram.

## Variables d'environnement requises sur Railway

```
ANTHROPIC_API_KEY=sk-ant-...
```

## Ce que fait l'agent

- 📧 Lit et répond aux emails SAV automatiquement toutes les 5 min
- 🛒 Vérifie les commandes sur Shopify en temps réel
- 📲 Alerte Telegram pour les urgences (réclamations, partenariats)
- 📊 Résumé quotidien envoyé sur Telegram à 20h
- ✍️ Signé : Daniel, cofondateur de Les Délices de l'Afrique

## Routes API

- `GET /` — statut du serveur
- `POST /cycle` — lancer un cycle manuellement
- `POST /summary` — envoyer le résumé maintenant
- `POST /test-telegram` — tester la connexion Telegram
