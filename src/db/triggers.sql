-- ---------------------------------------------------------------------------
-- The invariants, enforced by the database rather than by discipline.
--
-- Application code can be forgotten, refactored around, or bypassed by a
-- migration script someone wrote at midnight. These cannot. If you find
-- yourself wanting to drop one of these to make a feature work, that is the
-- signal to reconsider the feature.
-- ---------------------------------------------------------------------------


-- 1. No value without provenance ---------------------------------------------
--
-- Deferred to COMMIT so that a legitimate transaction may insert the cell and
-- its provenance in either order. What it forbids is a transaction that ends
-- with a filled cell and no origin record.

CREATE OR REPLACE FUNCTION assert_cell_provenance() RETURNS trigger AS $$
BEGIN
  -- The row may have been deleted later in the same transaction.
  IF NOT EXISTS (SELECT 1 FROM cell WHERE id = NEW.id) THEN
    RETURN NULL;
  END IF;

  IF NEW.state = 'filled' THEN
    IF NOT EXISTS (SELECT 1 FROM provenance WHERE cell_id = NEW.id) THEN
      RAISE EXCEPTION
        'invariant violated: cell % is filled with no provenance record', NEW.id
        USING HINT = 'Write the value through writeCellValue(); see CLAUDE.md commitment 1.';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM authorship WHERE cell_id = NEW.id) THEN
      RAISE EXCEPTION
        'invariant violated: cell % is filled with no authorship record', NEW.id
        USING HINT = 'Every value records whether a machine or a person put it there.';
    END IF;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER cell_requires_provenance
  AFTER INSERT OR UPDATE ON cell
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_cell_provenance();


-- 2. A refresh must not move the retention clock -----------------------------
--
-- This is the CNIL's finding against Kaspr, expressed as a constraint: they
-- retained contacts for five years "from each update", so an automatic refresh
-- renewed the clock forever and nothing was ever deleted.
--
-- Extending retention is sometimes legitimate (a changed lawful basis, an
-- explicit review). It is never something a background job does silently, so
-- it requires an explicit, auditable override.

CREATE OR REPLACE FUNCTION assert_retention_not_renewed() RETURNS trigger AS $$
BEGIN
  IF OLD.retention_expires_at IS NOT NULL
     AND NEW.retention_expires_at IS DISTINCT FROM OLD.retention_expires_at
     AND coalesce(current_setting('app.retention_override', true), 'off') <> 'on'
  THEN
    RAISE EXCEPTION
      'invariant violated: refresh moved retention_expires_at on cell % (% -> %)',
      NEW.id, OLD.retention_expires_at, NEW.retention_expires_at
      USING HINT = 'A refresh updates the value, never the clock. See CLAUDE.md commitment 2.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cell_retention_is_sticky
  BEFORE UPDATE ON cell
  FOR EACH ROW EXECUTE FUNCTION assert_retention_not_renewed();


-- 3. Provenance is append-only -----------------------------------------------
--
-- An origin record that can be edited is not an origin record. Deletion is
-- permitted only by cascade from the cell, and by erasure redaction, which
-- uses the same explicit override mechanism.

CREATE OR REPLACE FUNCTION assert_provenance_immutable() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('app.erasure_in_progress', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'invariant violated: provenance row % is append-only', OLD.id
    USING HINT = 'Corrections are recorded as contests, not as edits to history.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER provenance_append_only
  BEFORE UPDATE ON provenance
  FOR EACH ROW EXECUTE FUNCTION assert_provenance_immutable();


-- 4. A human-authored value is not silently overwritten ----------------------
--
-- Agents propose over human corrections; they do not replace them. The write
-- path enforces this too, but a trigger means a stray UPDATE cannot do it
-- either.

CREATE OR REPLACE FUNCTION assert_human_value_stands() RETURNS trigger AS $$
DECLARE
  origin text;
BEGIN
  IF NEW.value IS DISTINCT FROM OLD.value
     AND coalesce(current_setting('app.human_edit', true), 'off') <> 'on'
     AND coalesce(current_setting('app.erasure_in_progress', true), 'off') <> 'on'
  THEN
    SELECT a.origin::text INTO origin FROM authorship a WHERE a.cell_id = NEW.id;
    IF origin IN ('human', 'machine_then_human') THEN
      RAISE EXCEPTION
        'invariant violated: agent run tried to overwrite human-authored cell %', NEW.id
        USING HINT = 'Record a proposal instead. The person decides. See CLAUDE.md commitment 4.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cell_human_value_stands
  BEFORE UPDATE ON cell
  FOR EACH ROW EXECUTE FUNCTION assert_human_value_stands();
