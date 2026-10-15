.class public Lfixture/InheritedCaller;
.super Ljava/lang/Object;

.method public static viaChild(Lfixture/Child;)V
    .registers 1
    invoke-virtual {p0}, Lfixture/Child;->inherited()V
    return-void
.end method

.method public static viaChildAndFramework(Lfixture/Child;)V
    .registers 1
    invoke-virtual {p0}, Lfixture/Child;->inherited()V
    invoke-virtual {p0}, Ljava/lang/Object;->hashCode()I
    return-void
.end method

.method public static viaChildAndMissing(Lfixture/Child;Lmissing/Sub;)V
    .registers 2
    invoke-virtual {p0}, Lfixture/Child;->inherited()V
    invoke-virtual {p1}, Lmissing/Sub;->inherited()V
    return-void
.end method
