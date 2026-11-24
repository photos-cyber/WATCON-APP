# Word layout verification limitation

The DOCX was generated and its OOXML structure inspected. Native Word rendering in the sandbox failed with COM error 80070520 (no suitable logon session). A second attempt outside the sandbox created a hidden Word automation instance but stalled without producing a PDF. That audit-created hidden process was stopped. No native Word render is available; Word visual layout verification is BLOCKED. The separately generated PDF manual was rendered with PyMuPDF and inspected. Do not treat that as a native DOCX render.
