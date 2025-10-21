from flask import Flask, render_template, request
import requests
from bs4 import BeautifulSoup
import pandas as pd
import re
from rapidfuzz import fuzz
from pathlib import Path
import usaddress

app = Flask(__name__)

# --- cache setup ---
CACHE_DIR = Path("cache")
CACHE_DIR.mkdir(exist_ok=True)
zip_cache = {}  # in-memory cache

# --- normalization helpers ---
def normalize_text(s):
    """Normalize case and common abbreviations."""
    if not isinstance(s, str):
        return ""
    s = s.upper().strip()
    replacements = {
        "STREET": "ST",
        "AVENUE": "AVE",
        "ROAD": "RD",
        "DRIVE": "DR",
        "WEST": "W",
        "EAST": "E",
        "NORTH": "N",
        "SOUTH": "S",
        "BOULEVARD": "BLVD",
        "LANE": "LN",
        "COURT": "CT",
    }
    for k, v in replacements.items():
        s = s.replace(k, v)
    s = re.sub(r"\s+", " ", s)
    return s


def extract_street(addr):
    """Parse and return normalized street-only portion of an address using usaddress."""
    if not isinstance(addr, str):
        return ""
    try:
        parsed, _ = usaddress.tag(addr)
        parts = [
            parsed.get("AddressNumber", ""),
            parsed.get("StreetNamePreDirectional", ""),
            parsed.get("StreetName", ""),
            parsed.get("StreetNamePostType", ""),
        ]
        street = " ".join(filter(None, parts))
        return normalize_text(street)
    except usaddress.RepeatedLabelError:
        return normalize_text(addr)


# --- scrape + cache ---
def search_by_zip(zip_code):
    """Fetch and parse businesses for a given ZIP code (cached)."""
    if zip_code in zip_cache:
        return zip_cache[zip_code]

    cache_file = CACHE_DIR / f"{zip_code}.csv"
    if cache_file.exists():
        df = pd.read_csv(cache_file)
        zip_cache[zip_code] = df
        return df

    url = "https://mycpa.cpa.state.tx.us/staxpayersearch/locationSearch.do"
    payload = {
        "zipCode": zip_code,
        "city": "",
        "taxpayerName": "",
        "permitNumber": "",
        "searchType": "location",
    }
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Content-Type": "application/x-www-form-urlencoded",
    }

    response = requests.post(url, data=payload, headers=headers)
    soup = BeautifulSoup(response.text, "html.parser")
    table = soup.find("table", {"class": "table-bordered"})
    if not table:
        return pd.DataFrame()

    rows = []
    for tr in table.find_all("tr")[1:]:
        for a in tr.find_all("a"):
            a.decompose()
        tds = [td.get_text(strip=True) for td in tr.find_all("td")]
        if len(tds) == 8:
            rows.append(tds)

    cols = [
        "Business Name",
        "Status",
        "Address",
        "City/State/Zip",
        "Taxpayer ID",
        "Location #",
        "Permit Begin",
        "Permit End",
    ]
    df = pd.DataFrame(rows, columns=cols)
    df.to_csv(cache_file, index=False)
    zip_cache[zip_code] = df
    return df


# --- fuzzy address logic ---
def fuzzy_address_search(user_address, df, threshold=65):
    """Find closest address matches using parsed + normalized street comparison."""
    query_street = extract_street(user_address)
    if not query_street:
        return pd.DataFrame()

    df["ParsedStreet"] = df["Address"].apply(extract_street)
    df["Score"] = df["ParsedStreet"].apply(
        lambda x: fuzz.WRatio(query_street, x)  # more flexible than token_sort_ratio
    )
    results = df[df["Score"] >= threshold].sort_values(by="Score", ascending=False)
    return results


# --- web routes ---
@app.route("/", methods=["GET", "POST"])
def index():
    results = None
    address = ""
    if request.method == "POST":
        address = request.form.get("address", "").strip()
        zip_match = re.search(r"\b\d{5}\b", address)
        if zip_match:
            zip_code = zip_match.group(0)
            df = search_by_zip(zip_code)
            if not df.empty:
                results = fuzzy_address_search(address, df)
        else:
            results = pd.DataFrame()
    return render_template("index.html", results=results, address=address)


if __name__ == "__main__":
    app.run(debug=True)
