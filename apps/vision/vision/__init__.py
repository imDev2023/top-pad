"""Vamp Shield's vision service: the image signatures (PDQ and SSCD) that refuse a launch copying a protected coin's logo.

Spec section 10.2 runs it as one Cloudflare Container behind a Durable Object in the API Worker; spec section 6.2 holds the
thresholds the API applies to what it returns (PDQ distance 31 or less across the 8 orientations, SSCD cosine 0.75 or more).
"""

MODEL_NAME = "sscd_disc_mixup"
PDQ_VERSION = "pdqhash 0.2.8"
