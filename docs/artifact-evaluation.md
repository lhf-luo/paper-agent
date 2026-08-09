# Artifact Discovery Human Evaluation

[Documentation index](README.md) | [Web interface](web-interface.md) | [PDF and artifact workspace](pdf-artifact-workspace.md)

Paper Agent keeps Artifact detector output and human evaluation gold strictly separate. The detector may suggest repositories, datasets, supplemental files, project pages, or archival records, but those suggestions cannot establish ground truth by themselves.

## State model

| State | Location | Meaning | Counts as gold? |
| --- | --- | --- | --- |
| Pinned source | `eval-data/artifacts/sources.json` + ignored `eval-data/pdfs/*.pdf` | Intended public paper and fixed PDF SHA-256 | No |
| Detector snapshot | ignored `eval-data/artifacts/candidates/*.json` | Reproducible machine candidates and provenance | No |
| Browser draft | browser `localStorage`, keyed by slug + PDF SHA-256 | Recovery copy while a person is reviewing | No |
| Reviewed annotation | `eval-data/artifacts/annotations/*.json` | Independently reviewed, confirmed gold | Yes |

Changing the pinned PDF hash creates a different browser-draft key and invalidates source/snapshot mismatches. This prevents a review for one PDF version from silently becoming evidence for another.

## Prepare the local set

Use the project-local Node environment or the installed `paper-agent` command:

```powershell
npm run eval:artifacts:fetch
npm run eval:artifacts:bootstrap
paper-agent
```

If a newly downloaded source has no accepted hash yet, first verify manually that it is the intended paper, then run:

```powershell
npm run eval:artifacts:fetch -- --accept-new-hashes
```

Do not accept a new hash simply because a URL returned a PDF. Confirm the title, version, and source entry first.

## Review one paper

Open **Quality evaluation** in the left navigation.

1. Select a paper from the review queue. Pending papers are shown before completed ones.
2. Confirm that the displayed title, paper ID, PDF size, and SHA-256 prefix match the intended source.
3. Read every physical PDF page in the embedded viewer. Check footnotes, appendices, acknowledgements, and reference sections as well as the main body.
4. Tick a page only after inspecting that page for repositories, data, supplements, implementation pages, and archival records.
5. For every detector candidate, choose exactly one disposition:
   - **belongs to this paper:** assign a stable Artifact ID, kind, physical pages, accepted URL aliases, and an optional note;
   - **citation/unrelated:** give a concrete reason explaining why the URL is not this paper's Artifact.
6. When several candidate URLs identify the same Artifact, give them the same Artifact ID. The server merges aliases and pages only when their kind and note are consistent.
7. Add any detector-missed Artifact under **Manual Artifact**. A detector URL cannot be re-added manually; it must be classified in its candidate card.
8. Enter a real reviewer identity and an overall note when uncertainty or version differences should be preserved.
9. Confirm that every physical page and every candidate is complete, then select **Check exact plan and save**.
10. Read the confirmation card. It displays the destination, expected Artifacts, risk, and manifest fingerprint. Confirm only if it matches the review you just completed.

The UI creates `reviewedAt` at preparation time. Cancelling the confirmation does not write the annotation. Preparing again creates a fresh exact plan.

## Code-level safeguards

The Web page is not the trust boundary. The local service independently:

- resolves the PDF only under `eval-data/pdfs`;
- checks the `%PDF-` magic and fixed SHA-256;
- obtains the physical page count from `pdfinfo`;
- verifies that the candidate snapshot is still `machine-generated-candidate` and matches `sources.json`;
- requires the ordered list of every physical page;
- requires one and only one decision for every detector candidate;
- requires a reason for every ignored candidate;
- validates IDs, URL lists, kinds, pages, and bounded text sizes;
- rejects conflicting decisions for the same canonical URL;
- includes the complete annotation, PDF hash, page count, and previous annotation hash in the operation fingerprint;
- consumes a short-lived one-time confirmation grant;
- writes through a unique temporary file and atomic rename.

If the submission, candidate snapshot, PDF, or existing annotation changes after preparation, execution no longer matches the confirmed plan and is rejected.

## Draft recovery and privacy

The browser saves unfinished form state locally after an edit. It is intended only to recover from a refresh or accidental tab close.

- It is not sent to the evaluator until **prepare** is selected.
- It is not stored under `annotations/`.
- It is not counted by any release script.
- It is deleted best-effort after a successful gold write.
- Anyone sharing the same browser profile can potentially see local drafts, so use an appropriate OS/browser profile for sensitive review notes.

## Non-GUI fallback

Generate a local review aid with:

```powershell
npm run eval:artifacts:review-workspace
npm run eval:artifacts:review-workspace -- --slug=paper-slug
```

These files help organize page checks and candidates but remain untrusted machine-derived workspaces. They do not bypass the human-review requirements.

## Evaluation and strict gate

After real reviewed annotations exist:

```powershell
npm run eval:artifacts
npm run eval:artifacts:check
```

The strict check requires at least 30 fully human-reviewed papers, at least 20 gold Artifacts, precision/recall/kind accuracy of at least 0.90, and complete discovery provenance. Until the 30-paper review is genuinely complete, failure is the correct result and must not be hidden by synthetic or model-authored annotations.

Detector metrics describe only this fixed set. They do not prove that every publisher PDF, scanned paper, non-English paper, shortened URL, or dynamically rendered project page is handled correctly.
