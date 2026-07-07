use crate::models::{PaperSize, PaperUnit};

#[derive(Debug, Clone)]
pub struct PaperDimensions {
    pub width_mm: f64,
    pub height_mm: f64,
}

pub fn dimensions(size: &PaperSize) -> anyhow::Result<PaperDimensions> {
    match size {
        PaperSize::Standard(name) => standard(name),
        PaperSize::Custom(custom) => {
            let factor = match custom.unit {
                PaperUnit::Mm => 1.0,
                PaperUnit::In => 25.4,
            };
            Ok(PaperDimensions {
                width_mm: custom.width * factor,
                height_mm: custom.height * factor,
            })
        }
    }
}

fn standard(name: &str) -> anyhow::Result<PaperDimensions> {
    let (width_mm, height_mm) = match name {
        "A3" => (297.0, 420.0),
        "A4" => (210.0, 297.0),
        "A5" => (148.0, 210.0),
        "A6" => (105.0, 148.0),
        "B4" => (250.0, 353.0),
        "B5" => (176.0, 250.0),
        "Letter" => (216.0, 279.0),
        "Legal" => (216.0, 356.0),
        "Tabloid" => (279.0, 432.0),
        "4x6" => (102.0, 152.0),
        "5x7" => (127.0, 178.0),
        "6x8" => (152.0, 203.0),
        _ => anyhow::bail!("不支持的纸张尺寸: {name}"),
    };
    Ok(PaperDimensions {
        width_mm,
        height_mm,
    })
}
