# Speech to Text for Google Docs

Starter extension repo based on the `pattern` template.

Current status:

- separate product repository is initialized
- brand scaffold is set to `Speech to Text for Google Docs`
- auth, paywall, quota, and Stripe template structure are present
- vendored `pdfjs` assets are included in stable project paths

This repository is not fully product-complete yet.

Still required before launch:

- implement the real Google Docs speech-to-text feature
- replace inherited PDF-specific logic
- set the final domain
- set the final support email
- configure product-specific Stripe prices
- configure product-specific Google OAuth credentials
- update all store copy and privacy text

Key files:

- [CHANGE_REFERENCE.md](/Users/n.khorokhorina/speech-to-text-google-docs/CHANGE_REFERENCE.md)
- [PUBLISHING_COPY.md](/Users/n.khorokhorina/speech-to-text-google-docs/PUBLISHING_COPY.md)
- [manifest.json](/Users/n.khorokhorina/speech-to-text-google-docs/manifest.json)
- [background.js](/Users/n.khorokhorina/speech-to-text-google-docs/background.js)
- [server.js](/Users/n.khorokhorina/speech-to-text-google-docs/server.js)
