import os

def inject_secrets():
    print("Starting secret injection...")
    api_key = os.environ.get("FIREBASE_API_KEY")
    if not api_key:
        print("Warning: FIREBASE_API_KEY environment variable not found or empty.")
        return

    # Files to process
    files_to_update = ["index.html", "set.html"]
    
    gemini_key = os.environ.get("GEMINI_API_KEY")

    for filename in files_to_update:
        if os.path.exists(filename):
            with open(filename, 'r', encoding='utf-8') as f:
                content = f.read()

            updated = False
            if "__FIREBASE_API_KEY__" in content:
                content = content.replace("__FIREBASE_API_KEY__", api_key)
                updated = True
            
            if gemini_key and "__GEMINI_API_KEY__" in content:
                content = content.replace("__GEMINI_API_KEY__", gemini_key)
                updated = True

            if updated:
                with open(filename, 'w', encoding='utf-8') as f:
                    f.write(content)
                print(f"Successfully injected secrets into {filename}")
            else:
                print(f"No placeholder found in {filename}")
        else:
            print(f"File {filename} not found.")

if __name__ == "__main__":
    inject_secrets()
