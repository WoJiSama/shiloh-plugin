export type DiagnosticIncidentStatus = 'asserted' | 'denied' | 'figurative' | 'unknown';
export type DiagnosticSignal = 'burning_odor' | 'smoke' | 'fire' | 'electrical_fault';
export type DiagnosticDamageComponent = 'power_supply' | 'mainboard' | 'graphics_card' | 'cable' | 'capacitor' | 'unspecified_component';
export type DiagnosticDamageKind = 'damaged' | 'burned' | 'short_circuit' | 'overheated' | 'electrical_breakdown';
export type DiagnosticTemperaturePrerequisite = 'component_model' | 'measurement_point' | 'workload';
/** Evidence supports observations or reported findings, never a remote safety certificate. */
export interface DiagnosticEvidenceAssessment {
    damage: {
        status: 'unconfirmed' | 'reported_professional_finding';
        components: DiagnosticDamageComponent[];
        findings: {
            components: DiagnosticDamageComponent[];
            kind: DiagnosticDamageKind;
        }[];
        /** Explicit same-device professional exclusions; absent symptoms are not exclusions. */
        excludedFindings?: {
            components: DiagnosticDamageComponent[];
            kind: DiagnosticDamageKind;
            scope?: 'whole_device';
        }[];
    };
    temperature?: {
        readings: string[];
        componentModel?: string;
        measurementPoint?: string;
        workload?: string;
        missing: DiagnosticTemperaturePrerequisite[];
    };
}
export interface DiagnosticReplyViolation {
    code: 'unsupported_damage_diagnosis' | 'unsupported_damage_exclusion' | 'unsupported_temperature_assurance' | 'unsupported_temperature_diagnosis' | 'unsupported_safety_certification' | 'unmet_operational_prerequisite' | 'contradicted_professional_clearance' | 'unsafe_inspection_action';
    claim: string;
    reason: string;
    correctionInstruction: string;
}
export interface DiagnosticSubject {
    kind: 'speaker_device' | 'third_party_device' | 'unspecified_device';
    /** A conversation-local association, not a verified physical asset identifier. */
    key: string;
    label: string;
    userId?: string;
}
export interface DiagnosticSource {
    origin: 'current' | 'history' | 'quote' | 'forward';
    text: string;
    subject: DiagnosticSubject;
    incidentStatus: DiagnosticIncidentStatus;
    signals: DiagnosticSignal[];
    /** Milliseconds since epoch, when the source has an unambiguous timestamp. */
    at?: number;
    /** Only recent, timestamped reports can establish transient power/cooling state. */
    transientFactsFresh?: boolean;
    userId?: string;
    messageId?: string;
}
/** Reported preconditions for this device; these are not a remote safety certification. */
export interface DiagnosticContext {
    purpose: 'troubleshooting' | 'discussion' | 'figurative';
    subject: DiagnosticSubject;
    incident: {
        status: DiagnosticIncidentStatus;
        signals: DiagnosticSignal[];
    };
    /** off means reported unplugged/isolated, not merely a front-panel shutdown. */
    power: 'unknown' | 'off' | 'on';
    damageExclusion: 'unknown' | 'reported_professional_clearance';
    /** Kinds of checks that may be described after their prerequisites are met. */
    allowedChecks: ('static_observation' | 'operational_monitoring')[];
    unmetPrerequisites: ('power_isolated' | 'cooled' | 'electrical_damage_excluded')[];
    sources: DiagnosticSource[];
    /** Optional for compatibility with previously materialized conversation contexts. */
    evidenceAssessment?: DiagnosticEvidenceAssessment;
}
