let sequence = 0;
export function createDeltaForceReport(Base) {
    class DeltaForceReport extends Base {
        constructor(e) {
            super(e);
            this.model = "deltaForceReport";
        }
        async getData(data, scale = 1) {
            return {
                ...this.screenData,
                saveId: `delta-force-${String(this.userId || "report").replace(/[^a-zA-Z0-9_-]/g, "-")}-${Date.now()}-${++sequence}`,
                imgType: "png",
                ...data,
                sys: {
                    scale: this.scale(scale)
                }
            };
        }
        scale(pct = 1) {
            return `style=transform:scale(${Math.min(2, Math.max(0.5, pct))})`;
        }
    }
    return DeltaForceReport;
}
//# sourceMappingURL=DeltaForceReport.js.map