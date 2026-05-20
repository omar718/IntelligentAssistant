import asyncio
from app.services.r2_storage import B2Storage

async def main():
    b2 = B2Storage()

    # Upload
    print("Uploading test file...")
    await b2.upload("test/hello.txt", b"B2 connection works!", "text/plain")
    print("Upload OK")

    # Check exists
    found = await b2.exists("test/hello.txt")
    print(f"Exists check: {found}")

    # Download
    data = await b2.download("test/hello.txt")
    print(f"Download OK: {data.decode()}")

    # Cleanup
    await b2.delete("test/hello.txt")
    print("Delete OK")
    print("\nAll checks passed.")

asyncio.run(main())