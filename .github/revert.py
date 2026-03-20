import os

def revert_secrets():
    print("Starting secret reversion...")
    placeholder = "__FIREBASE_API_KEY__"
    
    # Files to process
    files_to_update = ["index.html", "set.html"]
    
    # We need to find the actual key to replace it back with the placeholder
    # Since we know the key from the injection, we can search for it or use a pattern
    import re
    api_key_pattern = re.compile(r'AIzaSy[0-9A-Za-z_-]{33}')

    for filename in files_to_update:
        if os.path.exists(filename):
            with open(filename, 'r', encoding='utf-8') as f:
                content = f.read()

            matches = api_key_pattern.findall(content)
            if matches:
                for match in set(matches):
                    content = content.replace(match, placeholder)
                    print(f"Replaced {match} with {placeholder} in {filename}")
                
                with open(filename, 'w', encoding='utf-8') as f:
                    f.write(content)
                print(f"Successfully reverted secrets in {filename}")
            else:
                print(f"No API Key found in {filename}")
        else:
            print(f"File {filename} not found.")

if __name__ == "__main__":
    revert_secrets()
