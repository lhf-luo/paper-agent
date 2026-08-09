# Reviewed annotations

Only independently reviewed JSON annotations belong here. Do not copy detector candidates unchanged and do not mark an annotation `human-reviewed` until every physical page of the pinned PDF has been inspected by the named reviewer.

The Web **Quality evaluation** page is the preferred writer because it binds the source PDF hash, page count, complete page checklist, all candidate decisions, manual detector misses, reviewer provenance, final annotation content, and previous annotation hash into an exact confirmation fingerprint. Its browser draft is not stored here and is not gold. The server writes a JSON annotation only after confirmation.

The strict release gate ignores this README and reads only `*.json` files. An empty directory therefore correctly means that the human Artifact evaluation has not been completed; do not add synthetic files merely to make the gate pass.
