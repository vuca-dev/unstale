//! The published catalog: shard lines, the per-technology index and the root.
//!
//! Written centrally (TypeScript, validated against the Zod generated from these types), read here.
//! Reader policy: unknown fields are ignored and an unknown closed-set value reads as `Other`, so an
//! older client keeps working when the catalog adds a field or a value (schema 1 stays schema 1).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const CATALOG_SCHEMA: u32 = 1;

/// What changed. Closed set; an unknown value reads as `Other`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChangeType {
    NewApi,
    NewOption,
    BehaviorChange,
    DefaultChange,
    Fix,
    Deprecation,
    Removal,
    StabilityChange,
    Performance,
    Security,
    Tooling,
    #[serde(other)]
    Other,
}

/// Where the change shows in a project. Closed set; an unknown value reads as `Other`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Surface {
    CodeApi,
    Configuration,
    FileConvention,
    CommandLine,
    SchemaOrMigration,
    TypesOnly,
    /// Behaves differently; nothing to write.
    RuntimeInternal,
    BuildTooling,
    #[serde(other)]
    Other,
}

/// Why the change matters, only where the source states or directly implies it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Benefit {
    Security,
    Correctness,
    Performance,
    Cost,
    /// Replaces code a project would otherwise write and maintain; counted at the edge only where the
    /// record's `replaces` terms are present in the project.
    Maintainability,
    /// Convenience, style, new capabilities, optional modernisation.
    None,
    #[serde(other)]
    Other,
}

/// How big a new capability is, as the classifier reads its record (`label_version` field). Read for new features only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Magnitude {
    /// An option or flag in a point release.
    Minor,
    /// A notable addition below a headline.
    Moderate,
    /// A major release's lead item, a launch, a new model or model family, a new API surface or product feature.
    Headline,
    #[serde(other)]
    Other,
}

/// How the source labels a change's stability (GA when released as stable without a label).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Maturity {
    Ga,
    Beta,
    Experimental,
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SubjectKind {
    Literal,
    Concept,
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceKind {
    ReleaseNotes,
    Docs,
    UpgradeGuide,
    Changelog,
    /// A security advisory (GitHub Advisory Database); the quote is its id and summary.
    Advisory,
    #[serde(other)]
    Other,
}

/// One release of the change on one release line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Release {
    /// Package URL of the component that shipped it, e.g. `pkg:npm/next`.
    pub component: String,
    pub version: String,
    /// ISO date, `YYYY-MM-DD`.
    pub date: String,
    /// The old release line, major (or 0.minor below 1.0): what edges before 16 October 2026 compare and what shards
    /// are named by. A record may hold several releases on one such line (one per line of the tech index's
    /// `releases`, which is the line to use).
    pub line: String,
    /// Present when the exact release is not known: the change shipped in a release from `version` up to this one.
    /// Set for what central reads from a moving page (an upgrade guide served from a `latest` or unversioned URL, first
    /// read or edited after its major line had later releases): the page's text then may describe any release of the
    /// line up to the newest one at the time. The edge places such a release only outside that range: an installed or
    /// target version inside it can neither have nor lack the change for certain.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub no_later_than: Option<String>,
}

/// A machine-comparable requirement, named as a project's manifest declares it in that ecosystem,
/// e.g. `{"ecosystem": "npm", "name": "node", "min": "24.0"}` (`engines.node`) or
/// `{"ecosystem": "composer", "name": "php", "min": "8.2"}`. No alias table: the stack map reads the same keys.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Prerequisite {
    /// Package URL type: `npm`, `composer`, `pypi`, `cargo`, `hex`, ...
    pub ecosystem: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<String>,
}

/// A search term and the number of the technology's sample repositories that contain it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Term(pub String, pub u32);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Evidence {
    pub kind: EvidenceKind,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
    pub quote: String,
    /// `sha256:` plus the hex digest of the snapshot the quote was taken from.
    pub snapshot: String,
}

/// A live record. Fields bump `revision` (decision fields) or `label_version` (ordering labels).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CapabilityRecord {
    /// `{technology}:{slug}`, assigned once.
    pub id: String,
    pub technology: String,
    pub revision: u32,
    pub label_version: u32,
    pub change_type: ChangeType,
    pub breaking: bool,
    pub surface: Surface,
    pub subject: String,
    pub subject_kind: SubjectKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub facet: Option<String>,
    /// At most 40 words.
    pub summary: String,
    pub benefit: Vec<Benefit>,
    /// The classifier's size of the change (records labelled before 23 October 2026 have none).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub magnitude: Option<Magnitude>,
    /// The classifier's reading of the source's stability label (records labelled before 23 October 2026 have none).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maturity: Option<Maturity>,
    pub releases: Vec<Release>,
    #[serde(default)]
    pub prerequisites: Vec<Prerequisite>,
    /// Requirements that cannot be checked from a manifest (a database server version). Shown to the
    /// agent; never block the record.
    #[serde(default)]
    pub conditions: Vec<String>,
    #[serde(default)]
    pub requires: Vec<String>,
    #[serde(default)]
    pub introduces: Vec<String>,
    #[serde(default)]
    pub terms: Vec<Term>,
    #[serde(default)]
    pub replaces: Vec<String>,
    pub evidence: Vec<Evidence>,
    #[serde(default)]
    pub related: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supersedes: Option<String>,
    /// Classifier output for the label fields, read with its confidence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub classifier: Option<Classification>,
    /// Reviewed security advisories whose fix this record describes, with the versions each affects. The edge
    /// decides from these, not from `releases`, which advisories a bump fixes (backports included).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub advisories: Vec<Advisory>,
}

/// A security advisory as its database states it (OSV: GHSA, PyPA, RustSec, Go vulndb, ...), with its ranges resolved
/// centrally against the technology's release index, so the edge needs no ecosystem-specific version parsing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Advisory {
    /// The advisory's id: the GHSA id where there is one, else the database's own (`PYSEC-...`, `RUSTSEC-...`).
    pub id: String,
    /// Other ids of the same advisory (CVE, other databases).
    #[serde(default)]
    pub aliases: Vec<String>,
    /// `low`, `medium`, `high` or `critical`, as the database states it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub severity: Option<String>,
    /// The database's one-line summary.
    #[serde(default)]
    pub summary: String,
    pub url: String,
    /// Affected versions per package; a project is affected when its version of `component` is in `range`.
    pub affected: Vec<AffectedRange>,
    /// The technology's releases the ranges were resolved against (central's release index when the advisory was
    /// attached). For a version in this list, `AffectedRange::versions` says whether it is affected; a version
    /// outside it is unknown, and the edge says nothing about the advisory for it. Absent in catalogs before
    /// 15 October 2026 (the edge then says nothing about advisories).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<Vec<String>>,
}

/// One affected range of an advisory for one package.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AffectedRange {
    /// Package URL, e.g. `pkg:npm/%40nestjs/platform-fastify`.
    pub component: String,
    /// The range for people (and edges before 15 October 2026): comparators joined by commas, e.g.
    /// `>= 16.0.0, < 16.2.5`; empty when the database states the range only as a version list or commits.
    pub range: String,
    /// The first version with the fix on this range's line, when there is one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub patched: Option<String>,
    /// The releases of `Advisory::index` this range affects, resolved centrally. Absent when central could not
    /// resolve the range (no version order for the ecosystem and no explicit list): the edge then says nothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub versions: Option<Vec<String>>,
}

/// Which classifier answered. Closed set; an unknown value reads as `Other`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum Classifier {
    Jev,
    /// Kept readable for records labelled before 15 October 2026; no longer called.
    OpenaiDecisions,
    /// Kept readable for records labelled 15–16 October 2026 (Luna through `codex exec`); no longer called.
    Codex,
    /// The fallback since 16 October 2026: the extraction chat model (gpt-6-luna) asked for choices only.
    Chat,
    #[serde(other)]
    Other,
}

/// A benefit value asked of the classifier and its probability.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BenefitScore {
    pub benefit: Benefit,
    pub p: f64,
}

/// The classifier's probabilities and confidence for a record's label fields.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Classification {
    /// Which classifier answered: `jev`, `chat`, or (older records) `codex` or `openai-decisions`.
    pub classifier: Classifier,
    /// The model the API reported, e.g. `jev-1.13.0` or `gpt-6-luna`.
    pub model: String,
    /// Confidence of the chosen value, as returned by the classifier.
    pub change_type: f64,
    pub surface: f64,
    /// Probability that the change is breaking.
    pub breaking: f64,
    /// Probability per benefit value asked (security, correctness, performance, cost, maintainability).
    pub benefit: Vec<BenefitScore>,
    /// Labels whose call is near the threshold (`breaking`, `benefit:security`, `change_type`, ...): flagged, never dropped.
    #[serde(default)]
    pub borderline: Vec<String>,
    /// Confidence of the chosen magnitude and maturity, when they were asked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub magnitude: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maturity: Option<f64>,
}

/// One line of a shard. A merged or retracted record stays in its shard as a stub.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "status", rename_all = "snake_case")]
// Read one line at a time and unpacked at once, so the size is transient; boxing `Active` would change every match site.
#[allow(clippy::large_enum_variant)]
pub enum ShardLine {
    Active(CapabilityRecord),
    Merged { id: String, merged_into: String },
    Retracted { id: String },
    /// A status this client does not know; the line is skipped. Reader only: not in the published schema.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ShardRef {
    pub line: String,
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
    pub records: u32,
}

/// `v1/tech/{technology}.json`: stable URL, polled with ETags.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TechIndex {
    pub schema: u32,
    pub technology: String,
    /// Size of the rarity sample; 0 means no sample (rarity computed at the edge from the catalog's terms).
    pub sample_n: u32,
    /// When the technology's sources were last checked (ISO timestamp).
    pub checked: String,
    pub shards: Vec<ShardRef>,
    /// The rarity sample's repositories and the commits counted (`sample_n` of them); absent when there is none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sample: Vec<SampleRepo>,
    /// The technology's release index: its stable releases in the catalog window, ascending by version, each with its
    /// publish date and its release line. A line is a set of versions inside which version order is publish order;
    /// central derives it from this index (the smallest version-prefix depth for which that holds). The edge decides
    /// availability by position in this list and by line (a record's release on the installed line at or before the
    /// installed version, or a line whose first release, marked `line_start`, postdates the record's release on an
    /// older line), and resolves advisory ranges (`AffectedRange::versions`) against it. Absent in catalogs before 16
    /// October 2026: the edge then uses the old rule (major, or 0.minor).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub releases: Vec<IndexRelease>,
    /// The technology's own packages (package URLs), as the coverage service describes the technology. A record whose
    /// releases name only other packages (published from the same repository, under a release-notes heading naming
    /// them) applies only where the repository uses one of those. Absent (older catalogs, technologies without a
    /// descriptor): every package a record names counts as the technology's.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub components: Vec<String>,
}

/// One release of a technology's release index (`TechIndex::releases`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct IndexRelease {
    pub version: String,
    /// ISO date, `YYYY-MM-DD`.
    pub date: String,
    /// The release line, e.g. `15.5` (central derives the depth per technology).
    pub line: String,
    /// This is the first release of its line (the line began inside the window: its first version is the line's
    /// zero version, `15.5.0` or `15.5`), so the line's start date is known and the line has every change released
    /// on an older line before that date. Absent when the line began before the window (start unknown).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub line_start: bool,
}

/// One repository of the term-rarity sample, at the commit whose files were counted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SampleRepo {
    /// `owner/name` on GitHub.
    pub repo: String,
    /// Full commit SHA.
    pub commit: String,
}

/// `v1/root.json`: rarely changes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Root {
    pub schema: u32,
    pub min_client: String,
}

/// `v1/technologies.json`: every technology the catalog has an index for (`v1/tech/<id>.json`), by id, with the first 16
/// hex digits of the sha256 of that index as served. A client asks only for the indexes of candidates named here, and
/// not for one whose cached copy has that hash, so neither an uncovered candidate nor an unchanged index costs a
/// request; without this file (an older export, a local directory) it asks for every candidate's index, a 404 meaning
/// not covered.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Technologies {
    pub schema: u32,
    pub technologies: std::collections::BTreeMap<String, String>,
}
