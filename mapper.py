import requests
from bs4 import BeautifulSoup
import pandas as pd

url = "https://mycpa.cpa.state.tx.us/staxpayersearch/locationSearch.do"
payload = {
    "zipCode": "79734",
    "city": "",
    "taxpayerName": "",
    "permitNumber": "",
    "searchType": "location"
}

headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Content-Type": "application/x-www-form-urlencoded"
}

response = requests.post(url, data=payload, headers=headers)

# Save the raw HTML to a file
with open("response_78701.html", "r", encoding="utf-8") as f:
    soup = BeautifulSoup(f, "html.parser")

table = soup.find("table", {"class": "table-bordered"})
rows = []

for tr in table.find_all("tr")[1:]:
    # Remove all <a> tags (like "Other Locations")
    for a in tr.find_all("a"):
        a.decompose()
    
    tds = [td.get_text(strip=True) for td in tr.find_all("td")]
    if len(tds) == 8:
        rows.append(tds)

columns = [
    "Business Name",
    "Status",
    "Address",
    "City/State/Zip",
    "Taxpayer ID",
    "Location #",
    "Permit Begin",
    "Permit End"
]

df = pd.DataFrame(rows, columns=columns)
print(df.head())
df.to_csv("taxpayer_79734_clean.csv", index=False)