# voters.gg

Messi vs Ronaldo live voting page.

## Firebase switch

The site works in local demo mode by default. To enable shared realtime voting:

1. Create a Firebase project.
2. Enable Realtime Database.
3. Enable Anonymous Authentication.
4. Copy your Firebase web app config into `config.js`.
5. Redeploy to Vercel.

## Recommended Realtime Database rules

Paste this into the Firebase Realtime Database rules editor:

```json
{
  "rules": {
    ".read": true,
    ".write": "auth != null"
  }
}
```

## Note

This is a lightweight public voting MVP. Anonymous auth plus client-side transactions are enough for launch, but determined users can still tamper with votes. For stricter anti-abuse, move vote writes behind a server function and add rate limits or CAPTCHA.
