type ActiveGroupsReader = () => ReadonlySet<string>;
export declare function publishActiveGameGroups(reader: ActiveGroupsReader): void;
export declare function readActiveGameGroups(): ReadonlySet<string>;
export {};
