    current_user: User = Depends(check_module_permission("invoicing", "view")),
):
    """
    Return all distinct import sources that exist in the database,
    together with the count of invoices, clients and products from each source.
    """
    pipeline = [
        {"$group": {"_id": "$imported_from", "invoice_count": {"$sum": 1}}},
        {"$match": {"_id": {"$ne": None}}},
    ]
    invoice_docs = await db.invoices.aggregate(pipeline).to_list(100)

    # Index by source for quick merging
    source_map: dict = {}
    for doc in invoice_docs:
        src = doc["_id"] or "unknown"
        source_map[src] = {
            "source": src,
            "invoice_count": doc["invoice_count"],
            "client_count": 0,
            "product_count": 0,
        }

    # Count clients per source
    async for doc in db.clients.aggregate([
        {"$group": {"_id": "$imported_from", "count": {"$sum": 1}}},
        {"$match": {"_id": {"$ne": None}}},
    ]):
        src = doc["_id"] or "unknown"
        if src in source_map:
            source_map[src]["client_count"] = doc["count"]

    # Count products per source. Products are not in the central tenant
    # collection registry because legacy rows may lack company_id, so scope
    # this aggregation explicitly rather than exposing cross-tenant totals.
    product_match = {} if is_platform_owner(current_user) else {
        "company_id": enforce_company_value(current_user, None)
    }
    async for doc in db.products.aggregate([
        {"$match": product_match},
        {"$group": {"_id": "$imported_from", "count": {"$sum": 1}}},
        {"$match": {"_id": {"$ne": None}}},
    ]):
        src = doc["_id"] or "unknown"
        if src in source_map:
            source_map[src]["product_count"] = doc["count"]

    return list(source_map.values())


@router.delete("/invoices/remove-backup")
async def remove_backup(
    source: str,
    current_user: User = Depends(check_module_permission("invoicing", "delete")),
):
    """
    Delete ALL invoices, clients and products that were imported from *source*.
    Requires DELETE permission on the invoicing module.
    """
    if not source:
        raise HTTPException(status_code=400, detail="source query param is required")

    company_id = None if is_platform_owner(current_user) else enforce_company_value(current_user, None)
    scoped_filter = {"imported_from": source}
    if company_id is not None:
        scoped_filter["company_id"] = company_id
