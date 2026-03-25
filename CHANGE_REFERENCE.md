# Speech to Text for Google Docs Change Reference

This file is the working reference for the new product scaffold.

## Current Status

- Product name: `Speech to Text for Google Docs`
- Project folder: [SpeechToTextForGoogleDocs](/Users/n.khorokhorina/Self/SpeechToTextForGoogleDocs)
- This is a template-derived scaffold, not a launch-ready product yet.

## What Is Already Reused

- Google sign-in flow
- device token flow
- free trial and paid quota structure
- Stripe checkout gating
- welcome page structure
- popup and paywall structure
- static marketing site structure

## What Still Must Be Replaced

- product-specific feature logic for Google Docs dictation
- final domain
- final support email
- final privacy policy text
- final site text
- final icons and screenshots
- final Stripe products and price IDs
- final Google OAuth credentials
- final backend env

## Current Placeholder Risk

Some inherited code still points to the old product backend until the new backend/domain is configured.

Before shipping, replace:

- `REMOTE_API_BASE_URL` in [background.js](/Users/n.khorokhorina/Self/SpeechToTextForGoogleDocs/background.js)
- host permissions in [manifest.json](/Users/n.khorokhorina/Self/SpeechToTextForGoogleDocs/manifest.json)
- support email placeholders in UI/site files
- publish copy in [PUBLISHING_COPY.md](/Users/n.khorokhorina/Self/SpeechToTextForGoogleDocs/PUBLISHING_COPY.md)

## Product Setup Checklist

1. Decide the final domain.
2. Decide the support email.
3. Replace product copy across popup, welcome page, paywall, and `site/`.
4. Implement the real Google Docs speech-to-text feature.
5. Create product-specific Stripe prices.
6. Create product-specific Google OAuth credentials.
7. Deploy product-specific backend and site.
8. Rebuild the Chrome Web Store zip.

## Local Repo Workflow

This project should live in its own Git repository, separate from `FocusTrace`.

Suggested local workflow:

```bash
cd /Users/n.khorokhorina/Self/SpeechToTextForGoogleDocs
git init
git add .
git commit -m "Initial Speech to Text for Google Docs scaffold"
```
