/** Shared schema contract for console forms and the legacy Guoba adapter. */
export interface ConfigSchemaItem {
    field?: string;
    label?: string;
    component: string;
    required?: boolean;
    bottomHelpMessage?: string;
    helpMessage?: string;
    componentProps?: ConfigComponentProps;
    [extension: string]: unknown;
}
export interface ConfigComponentProps {
    schemas?: ConfigSchemaItem[];
    options?: {
        label: string;
        value: string | number | boolean;
        [extension: string]: unknown;
    }[];
    min?: number;
    max?: number;
    step?: number;
    placeholder?: string;
    [extension: string]: unknown;
}
