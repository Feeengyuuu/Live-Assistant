# Product

## Register

product

## Users

Desktop browser users who follow live broadcasters across Douyu, Huya, Bilibili, Douyin and Twitch. The current user operates the installed extension and wants quicker, more reliable daily use.

## Product Purpose

Show followed live rooms together and open the selected room quickly. Below live cards, offer an offline list that starts collapsed and loads on demand, with favorites and evidence-backed last-live information. Settings control which platforms appear, their order and floating navigation.

## Brand Personality

Modern, direct and familiar. Preserve the existing extension identity and blue accent.

## Anti-references

Avoid a dashboard redesign of the approved three-column home screen, unnecessary view modes, decorative animation and settings that require scrolling to find the save action.

## Design Principles

- Preserve the user's existing favorites and preferences through updates.
- Keep platform selection and order together and immediately understandable.
- Make saving and leaving settings easy to find.
- Separate recovery actions from routine changes, and explain their scope.
- Show failures and old data honestly while keeping successful content usable.
- Preserve three columns for live cards; use two compact columns for offline entries below them, with no preview-image requests for offline rows.
- Prioritize responsive live browsing. Each new popup starts with Offline collapsed; do not persist expansion, request auxiliary offline directories, or create and redraw offline rows while collapsed.
- Keep live results usable while a separate offline directory is loading. A successful live refresh does not establish that the offline directory is fresh.
- Distinguish a provider's start time, a provider's general live-record time and the extension's own last-seen-live observation. Show no record when none is available.

## Offline Coverage and History

Douyu and Huya reuse explicit offline records from their follow-list pagination. Expanding Offline uses available data before requesting Bilibili's separate official live-follow directory as needed. Manual refresh only includes that auxiliary request while Offline is expanded. Keep independent request status and freshness, a 20-page cap, and a shared 10-second deadline; longer directories may remain partial. Do not trade daily responsiveness for unbounded full-directory requests.

Douyin and Twitch currently lack a verified offline directory. A missing live entry, failure, unknown state or rerun must not be treated as evidence of being offline. Complete coverage describes the supported live-follow source, not every followed platform account. A provider's empty or zero historical timestamp remains unknown unless an existing local observation is available; no bulk room queries are added to reconstruct history.

Offline and live rows share favorites. Each section sorts favorites first, and a room must not appear in both sections at once. Floating platform navigation prefers a live card and may target an offline row only when the list is already expanded. It does not implicitly expand the list or start an auxiliary request.

Local last-seen observations are recorded only after complete, successful live responses, kept for up to 180 days and 1,000 broadcasters, and cleared for a platform when its main authentication is confirmed invalid. Opening cached results and fetching images must not create observations. There is no continuous monitoring while the popup is closed. Source and timestamp evidence is documented in [docs/offline-api-evidence.md](docs/offline-api-evidence.md).

## Accessibility & Inclusion

Retain keyboard-operable links, labeled switches, visible focus, system light/dark themes and reduced-motion support already implemented in the code. No additional user-specific accessibility requirements were supplied.
