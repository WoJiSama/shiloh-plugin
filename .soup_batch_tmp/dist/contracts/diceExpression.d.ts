export type ExpressionValue = unknown;
export type ExpressionNode = {
    pos: number;
} & ({
    type: 'Literal';
    value: string | number | boolean | null;
} | {
    type: 'DiceExpression';
    raw: string;
} | {
    type: 'Reference';
    path: string[];
} | {
    type: 'UnaryExpression';
    operator: string;
    argument: ExpressionNode;
} | {
    type: 'BinaryExpression';
    operator: string;
    left: ExpressionNode;
    right: ExpressionNode;
} | {
    type: 'ConditionalExpression';
    test: ExpressionNode;
    consequent: ExpressionNode;
    alternate: ExpressionNode;
} | {
    type: 'CallExpression';
    name: string;
    arguments: ExpressionNode[];
});
export type Token = {
    type: 'number';
    value: number;
    pos: number;
} | {
    type: 'eof' | 'dice' | 'string' | 'identifier' | 'operator' | 'punctuation';
    value: string;
    pos: number;
};
export interface ExpressionOptions {
    maxLength?: number;
    maxNodes?: number;
    maxDepth?: number;
    maxDiceCount?: number;
    maxAbsValue?: number;
    random?: () => number;
    rollStandard?: ((raw: string) => {
        detail?: string;
        total: number;
    }) | undefined;
    diceSets?: Record<string, {
        label?: string;
        faces: (number | string | {
            value: number;
            text?: string;
            weight?: number;
        })[];
    }>;
    customFunctions?: Record<string, (args: unknown[], scope: {
        context: unknown;
        state: ExpressionState;
    }) => unknown> | null;
}
export interface ExpressionState {
    diceSets: NonNullable<ExpressionOptions['diceSets']>;
    rollStandard: ExpressionOptions['rollStandard'];
    random: () => number;
    maxDiceCount: number;
    maxAbsValue: number;
    customFunctions: ExpressionOptions['customFunctions'];
    diceCount: number;
    traces: string[];
}
