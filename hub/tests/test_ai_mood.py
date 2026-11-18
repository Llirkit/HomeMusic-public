from sqlalchemy import select


async def test_failed_mood_download_consumes_one_reserve(hub_env):
    from app.catalog.models import CatalogTrack
    from app.db import session_scope
    from app.jobs.downloads import _replace_failed_mood_track, item_ref
    from app.models import DownloadBatch, DownloadItem, Job, MoodMix, User

    reserve = CatalogTrack(ref="dz:22", source="dz", id="22", artist="Новый артист",
                           artists=["Новый артист"], title="Запасная песня")
    async with session_scope() as s:
        user = User(nd_username="admin", nd_password_enc="test", is_admin=True)
        s.add(user)
        await s.flush()
        batch = DownloadBatch(user_id=user.id, origin="assistant", title="Меланхолия",
                              target_playlist_id="playlist-1")
        s.add(batch)
        await s.flush()
        failed = DownloadItem(batch_id=batch.id, user_id=user.id, status="failed", query_json={
            "query": {"artist": "Первый", "title": "Не скачался"}, "meta": {"track_ref": "dz:11"}})
        s.add(failed)
        await s.flush()
        s.add(MoodMix(user_id=user.id, batch_id=batch.id, nd_playlist_id="playlist-1", name="Меланхолия",
                      query="меланхоличная музыка", library_count=1, new_count=1,
                      reserve_json=[reserve.model_dump(mode="json")]))
        await s.flush()
        await _replace_failed_mood_track(s, failed)

    async with session_scope() as s:
        mood = (await s.execute(select(MoodMix))).scalar_one()
        items = list((await s.execute(select(DownloadItem).where(DownloadItem.batch_id == mood.batch_id)
                                      .order_by(DownloadItem.id))).scalars())
        assert [item_ref(i) for i in items] == ["dz:11", "dz:22"]
        assert items[1].status == "queued" and mood.reserve_json == []
        job = (await s.execute(select(Job).where(Job.kind == "download_item"))).scalar_one()
        assert job.payload_json == {"item_id": items[1].id}
