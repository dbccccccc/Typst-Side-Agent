# Privacy Policy for Typst Side Agent

Last updated: 2026-04-23

This Privacy Policy explains how Typst Side Agent ("the extension") handles data.
Typst Side Agent is an independent open-source Chrome extension for assisting
editing workflows on `typst.app`.

## 1. Scope

This policy applies to the extension package and its behavior when used in
Chrome. It does not replace the privacy policies of:

- `typst.app`
- AI model providers configured by the user
- User-configured custom tool endpoints
- User-configured MCP server endpoints

## 2. Core principle

The extension is designed to be user-driven. It only processes data needed to
provide its single purpose: assisting users with Typst document editing tasks in
the side panel.

## 3. Data processed by the extension

Depending on user actions and settings, the extension may process:

- **Website content:** Typst document text, selected text, diagnostics, and
  optional preview/image attachments from `typst.app`.
- **Authentication information:** API keys and optional custom headers entered
  by the user for model providers, custom tools, or MCP servers.
- **Extension settings and chat/session metadata:** local preferences, model
  configuration, tool configuration, MCP configuration, and chat/session history
  stored in browser local extension storage.

The extension does **not** intentionally collect health, financial, location, or
creditworthiness data.

## 4. How data is used

Data is used only to provide extension functionality, including:

- Reading and editing Typst content based on explicit user requests
- Running diagnostics-aware assistant workflows
- Sending user-requested prompts/context to configured model endpoints
- Calling user-configured custom tools and MCP servers
- Persisting local settings and chat/session state

## 5. Data sharing and transfer

The extension does not sell personal data.

Data may be transmitted to third parties only when required for the extension's
intended function and initiated by user configuration or action, such as:

- AI model API endpoints configured by the user
- Custom HTTPS tool endpoints configured by the user
- MCP server endpoints configured by the user

The extension publisher does not operate or control those third-party services.
Users are responsible for reviewing their privacy and security terms.

## 6. Local storage and retention

Extension data is stored locally using `chrome.storage.local` in the user's
browser profile, including settings, session history, and user-provided
credentials/headers.

Users can delete extension data by:

- Removing chats/sessions in the extension UI
- Clearing extension storage in Chrome extension settings
- Uninstalling the extension

## 7. Permissions and why they are needed

The extension requests only permissions needed for its single purpose:

- `sidePanel`: render the assistant interface in Chrome side panel
- `activeTab`: operate on the currently active Typst tab
- `scripting`: inject/execute scripts on Typst pages to read/edit content
- `tabs`: identify, message, and manage relevant Typst tabs
- `storage`: save settings and session state locally
- `webNavigation`: detect Typst SPA route changes for correct tab behavior

Host permissions:

- `https://typst.app/*`: required to operate on Typst editor pages
- `http://*/*` and `https://*/*`: required for user-configured model APIs,
  custom tool endpoints, and MCP servers

## 8. Remote code

The extension does not load or execute remote JavaScript or WebAssembly as code.
All executable extension code is packaged with the extension. Network requests
are API/data requests only.

## 9. Security

Reasonable measures are taken to minimize unnecessary data handling and keep
processing scoped to user-requested operations. However, no transmission or
storage system is guaranteed to be 100% secure.

## 10. Children

The extension is not directed to children and is not intended for use by
children under applicable legal age thresholds.

## 11. Changes to this policy

This policy may be updated when extension features or data practices change.
Material updates will be reflected by updating the "Last updated" date.

## 12. Contact

For privacy questions or requests, contact the project maintainer through the
project repository issue tracker:

- https://github.com/dbccccccc/Typst-Side-Agent/issues
