# Speech to Text Google Docs Change Reference

This file is the working reference for the live product codebase.

## Current Status

- Product name: `Speech to Text Google Docs`
- Project folder: [speech-to-text-google-docs](/Users/n.khorokhorina/speech-to-text-google-docs)
- The extension runtime is Google Docs-specific.
- Dictation uses microphone capture in the content script and OpenAI transcription through the backend.

## What Is Already Reused

- Google sign-in flow
- device token flow
- free trial and paid quota structure
- Stripe checkout gating
- welcome page structure
- popup and paywall structure
- static marketing site structure
- OpenAI transcription backend route

## What Still Must Be Replaced

- final domain
- final support email
- final privacy policy text
- final site text
- final icons and screenshots
- final Stripe products and price IDs
- final Google OAuth credentials
- final backend env

## Current Placeholder Risk

Before shipping, replace:

- `REMOTE_API_BASE_URL` in [background.js](/Users/n.khorokhorina/speech-to-text-google-docs/background.js)
- support email placeholders in UI/site files
- publish copy in [PUBLISHING_COPY.md](/Users/n.khorokhorina/speech-to-text-google-docs/PUBLISHING_COPY.md)

## Product Setup Checklist

1. Decide the final domain.
2. Decide the support email.
3. Replace product copy across popup, welcome page, paywall, and `site/`.
4. Create product-specific Stripe prices.
5. Create product-specific Google OAuth credentials.
6. Set `OPENAI_API_KEY` and optional `OPENAI_TRANSCRIBE_MODEL` on the backend.
7. Deploy product-specific backend and site.
8. Rebuild the Chrome Web Store zip.

## Local Repo Workflow

This project lives in its own Git repository, separate from other products.
